//! The approval gate: pending requests that block an MCP tool call until a
//! human decides (or the request times out and expires).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::Serialize;
use serde_json::{json, Value};
use tokio::sync::watch;

use crate::db::{new_id, now, Db};
use crate::error::{ApiError, ApiResult};
use crate::events::Events;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Approval {
    pub id: String,
    pub tool: String,
    pub tier: i64,
    pub args_json: Value,
    pub summary: String,
    pub status: String,
    pub requested_by: String,
    pub created_at: String,
    pub decided_at: Option<String>,
    pub note: Option<String>,
}

const COLS: &str =
    "id, tool, tier, args_json, summary, status, requested_by, created_at, decided_at, note";

fn row(r: &Row) -> rusqlite::Result<Approval> {
    let args: String = r.get(3)?;
    let args_json = serde_json::from_str(&args).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(3, rusqlite::types::Type::Text, Box::new(e))
    })?;
    Ok(Approval {
        id: r.get(0)?,
        tool: r.get(1)?,
        tier: r.get(2)?,
        args_json,
        summary: r.get(4)?,
        status: r.get(5)?,
        requested_by: r.get(6)?,
        created_at: r.get(7)?,
        decided_at: r.get(8)?,
        note: r.get(9)?,
    })
}

pub fn get(conn: &Connection, id: &str) -> ApiResult<Option<Approval>> {
    Ok(conn
        .query_row(
            &format!("SELECT {COLS} FROM approvals WHERE id = ?1"),
            params![id],
            row,
        )
        .optional()?)
}

pub fn list(conn: &Connection, status: Option<&str>) -> ApiResult<Vec<Approval>> {
    let mut out = Vec::new();
    match status {
        Some(s) => {
            if !["pending", "approved", "denied", "expired"].contains(&s) {
                return Err(ApiError::bad_request(format!("invalid status '{s}'")));
            }
            let order = if s == "pending" { "ASC" } else { "DESC" };
            let mut st = conn.prepare(&format!(
                "SELECT {COLS} FROM approvals WHERE status = ?1 ORDER BY rowid {order}"
            ))?;
            for a in st.query_map(params![s], row)? {
                out.push(a?);
            }
        }
        None => {
            let mut st =
                conn.prepare(&format!("SELECT {COLS} FROM approvals ORDER BY rowid DESC"))?;
            for a in st.query_map([], row)? {
                out.push(a?);
            }
        }
    }
    Ok(out)
}

/// Owns the in-memory wakeups for blocked tool calls.
pub struct Approvals {
    db: Db,
    events: Events,
    waiters: Mutex<HashMap<String, watch::Sender<Option<String>>>>,
}

/// If a waiting call is dropped (client disconnected) the approval expires.
struct WaitGuard<'a> {
    owner: &'a Approvals,
    id: String,
    armed: bool,
}

impl Drop for WaitGuard<'_> {
    fn drop(&mut self) {
        // Several callers may share one approval; only the last one out
        // cancels it. (Our own receiver is still alive here, hence <= 1.)
        let others = self.owner.waiter_count(&self.id).saturating_sub(1);
        if others == 0 {
            if self.armed {
                let _ = self
                    .owner
                    .expire_if_pending(&self.id, "requester disconnected");
            }
            self.owner.remove_waiter(&self.id);
        }
    }
}

impl Approvals {
    pub fn new(db: Db, events: Events) -> Arc<Approvals> {
        Arc::new(Approvals {
            db,
            events,
            waiters: Mutex::new(HashMap::new()),
        })
    }

    fn waiter_count(&self, id: &str) -> usize {
        self.waiters
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(id)
            .map(|tx| tx.receiver_count())
            .unwrap_or(0)
    }

    fn remove_waiter(&self, id: &str) {
        self.waiters
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(id);
    }

    /// Anything still pending belongs to a previous process and can never be
    /// resumed: expire it.
    pub fn expire_stale(&self) -> ApiResult<usize> {
        self.db.with(|c| {
            Ok(c.execute(
                "UPDATE approvals SET status='expired', decided_at=?1, note='core restarted'
                 WHERE status='pending'",
                params![now()],
            )?)
        })
    }

    pub fn create(
        &self,
        tool: &str,
        tier: u8,
        args: &Value,
        summary: &str,
        requested_by: &str,
    ) -> ApiResult<Approval> {
        let a = Approval {
            id: new_id(),
            tool: tool.to_string(),
            tier: tier as i64,
            args_json: args.clone(),
            summary: summary.to_string(),
            status: "pending".into(),
            requested_by: requested_by.to_string(),
            created_at: now(),
            decided_at: None,
            note: None,
        };
        self.db.with(|c| {
            c.execute(
                &format!(
                    "INSERT INTO approvals({COLS}) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,NULL,NULL)"
                ),
                params![
                    a.id,
                    a.tool,
                    a.tier,
                    a.args_json.to_string(),
                    a.summary,
                    a.status,
                    a.requested_by,
                    a.created_at
                ],
            )?;
            Ok(())
        })?;
        let (tx, _rx) = watch::channel(None);
        self.waiters
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(a.id.clone(), tx);
        tracing::info!(approval_id = %a.id, tool = %a.tool, tier = a.tier, "approval created");
        self.events.emit("approval.created", json!(a));
        Ok(a)
    }

    fn transition(
        &self,
        id: &str,
        status: &str,
        note: Option<&str>,
    ) -> ApiResult<Option<Approval>> {
        let changed = self.db.with(|c| {
            Ok(c.execute(
                "UPDATE approvals SET status=?2, decided_at=?3, note=?4
                 WHERE id=?1 AND status='pending'",
                params![id, status, now(), note],
            )?)
        })?;
        if changed == 0 {
            return Ok(None);
        }
        let a = self
            .db
            .with(|c| get(c, id))?
            .ok_or_else(|| ApiError::internal("approval vanished"))?;
        if let Some(tx) = self
            .waiters
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(id)
        {
            tx.send_replace(Some(status.to_string()));
        }
        tracing::info!(approval_id = %a.id, tool = %a.tool, tier = a.tier, decision = %status, "approval decided");
        self.events.emit("approval.decided", json!(a));
        Ok(Some(a))
    }

    /// Expire every pending approval now (used on shutdown) so blocked calls return.
    pub fn expire_all_pending(&self, note: &str) {
        let ids: Vec<String> = self
            .db
            .with(|c| list(c, Some("pending")))
            .map(|v| v.into_iter().map(|a| a.id).collect())
            .unwrap_or_default();
        for id in ids {
            let _ = self.expire_if_pending(&id, note);
        }
    }

    /// Approve or deny a pending approval.
    pub fn decide(&self, id: &str, approve: bool, note: Option<&str>) -> ApiResult<Approval> {
        let status = if approve { "approved" } else { "denied" };
        match self.transition(id, status, note)? {
            Some(a) => Ok(a),
            None => match self.db.with(|c| get(c, id))? {
                None => Err(ApiError::not_found(format!("approval '{id}' not found"))),
                Some(a) => Err(ApiError::conflict(format!("approval already {}", a.status))),
            },
        }
    }

    pub fn expire_if_pending(&self, id: &str, note: &str) -> ApiResult<Option<Approval>> {
        self.transition(id, "expired", Some(note))
    }

    /// Block until the approval is decided or `timeout` elapses (then it is
    /// expired). Returns the final approval row.
    pub async fn wait(&self, id: &str, timeout: Duration) -> ApiResult<Approval> {
        let mut rx = {
            let w = self.waiters.lock().unwrap_or_else(|e| e.into_inner());
            w.get(id).map(|tx| tx.subscribe())
        };
        let mut guard = WaitGuard {
            owner: self,
            id: id.to_string(),
            armed: true,
        };
        if let Some(rx) = rx.as_mut() {
            let timed_out = tokio::time::timeout(timeout, rx.wait_for(|v| v.is_some()))
                .await
                .is_err();
            if timed_out {
                self.expire_if_pending(id, "timed out waiting for a decision")?;
            }
        }
        guard.armed = false;
        drop(guard);
        self.db
            .with(|c| get(c, id))?
            .ok_or_else(|| ApiError::internal("approval vanished"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> (Arc<Approvals>, Db, Events) {
        let db = Db::open_memory().unwrap();
        let ev = Events::new();
        (Approvals::new(db.clone(), ev.clone()), db, ev)
    }

    #[tokio::test]
    async fn approve_wakes_waiter() {
        let (ap, db, ev) = setup();
        let mut rx = ev.subscribe();
        let a = ap
            .create(
                "tasks_create",
                1,
                &json!({"title": "x"}),
                "Create x",
                "agent",
            )
            .unwrap();
        assert_eq!(rx.recv().await.unwrap().kind, "approval.created");
        let ap2 = ap.clone();
        let id = a.id.clone();
        let h = tokio::spawn(async move { ap2.wait(&id, Duration::from_secs(5)).await });
        tokio::time::sleep(Duration::from_millis(30)).await;
        let d = ap.decide(&a.id, true, Some("ok")).unwrap();
        assert_eq!(d.status, "approved");
        assert_eq!(h.await.unwrap().unwrap().status, "approved");
        assert_eq!(rx.recv().await.unwrap().kind, "approval.decided");
        assert_eq!(db.with(|c| list(c, Some("pending"))).unwrap().len(), 0);
    }

    #[tokio::test]
    async fn decision_before_wait_is_seen() {
        let (ap, _db, _ev) = setup();
        let a = ap.create("t", 1, &json!({}), "s", "agent").unwrap();
        ap.decide(&a.id, false, Some("no")).unwrap();
        let got = ap.wait(&a.id, Duration::from_secs(1)).await.unwrap();
        assert_eq!(got.status, "denied");
        assert_eq!(got.note.as_deref(), Some("no"));
    }

    #[tokio::test]
    async fn timeout_expires() {
        let (ap, _db, ev) = setup();
        let mut rx = ev.subscribe();
        let a = ap.create("t", 1, &json!({}), "s", "agent").unwrap();
        let got = ap.wait(&a.id, Duration::from_millis(50)).await.unwrap();
        assert_eq!(got.status, "expired");
        assert!(got.decided_at.is_some());
        let _ = rx.recv().await;
        assert_eq!(rx.recv().await.unwrap().kind, "approval.decided");
        // can no longer be decided
        assert_eq!(ap.decide(&a.id, true, None).unwrap_err().status, 409);
    }

    #[tokio::test]
    async fn dropped_wait_expires() {
        let (ap, db, _ev) = setup();
        let a = ap.create("t", 1, &json!({}), "s", "agent").unwrap();
        let ap2 = ap.clone();
        let id = a.id.clone();
        let h = tokio::spawn(async move { ap2.wait(&id, Duration::from_secs(60)).await });
        tokio::time::sleep(Duration::from_millis(30)).await;
        h.abort();
        let _ = h.await;
        let cur = db.with(|c| get(c, &a.id)).unwrap().unwrap();
        assert_eq!(cur.status, "expired");
    }

    #[test]
    fn decide_errors_and_stale() {
        let (ap, db, _ev) = setup();
        assert_eq!(ap.decide("nope", true, None).unwrap_err().status, 404);
        let a = ap.create("t", 1, &json!({}), "s", "agent").unwrap();
        ap.decide(&a.id, true, None).unwrap();
        assert_eq!(ap.decide(&a.id, false, None).unwrap_err().status, 409);
        let b = ap.create("t", 1, &json!({}), "s", "agent").unwrap();
        assert_eq!(ap.expire_stale().unwrap(), 1);
        assert_eq!(
            db.with(|c| get(c, &b.id)).unwrap().unwrap().status,
            "expired"
        );
        assert!(db.with(|c| list(c, Some("bogus"))).is_err());
        assert_eq!(db.with(|c| list(c, None)).unwrap().len(), 2);
    }
}
