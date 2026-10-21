//! Append-only journal of writes: idempotency keys and undo via inverse ops.

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::Serialize;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use crate::db::{new_id, now};
use crate::error::{ApiError, ApiResult};
use crate::objects::tasks::{self, Task};

/// Derived idempotency keys are only honoured for this long (seconds).
pub const DERIVED_WINDOW_SECS: i64 = 60;
pub const DERIVED_PREFIX: &str = "derived:";

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct JournalEntry {
    pub id: String,
    pub ts: String,
    pub actor: String,
    pub tool: String,
    pub args_json: Value,
    pub result_json: Value,
    pub approval_id: Option<String>,
    pub idempotency_key: Option<String>,
    pub inverse_json: Option<Value>,
    pub undone_at: Option<String>,
    pub args_hash: Option<String>,
}

pub struct NewEntry<'a> {
    pub actor: &'a str,
    pub tool: &'a str,
    pub args: &'a Value,
    pub result: &'a Value,
    pub approval_id: Option<&'a str>,
    pub key: Option<&'a str>,
    pub inverse: Option<&'a Value>,
    pub args_hash: Option<&'a str>,
}

const COLS: &str =
    "id, ts, actor, tool, args_json, result_json, approval_id, idempotency_key, inverse_json, undone_at, args_hash";

fn parse(s: String) -> rusqlite::Result<Value> {
    serde_json::from_str(&s).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
    })
}

fn row(r: &Row) -> rusqlite::Result<JournalEntry> {
    let inverse: Option<String> = r.get(8)?;
    Ok(JournalEntry {
        id: r.get(0)?,
        ts: r.get(1)?,
        actor: r.get(2)?,
        tool: r.get(3)?,
        args_json: parse(r.get(4)?)?,
        result_json: parse(r.get(5)?)?,
        approval_id: r.get(6)?,
        idempotency_key: r.get(7)?,
        inverse_json: inverse.map(parse).transpose()?,
        undone_at: r.get(9)?,
        args_hash: r.get(10)?,
    })
}

/// Recursively sort object keys so equal args always serialize identically.
pub fn canonical_json(v: &Value) -> String {
    fn canon(v: &Value) -> Value {
        match v {
            Value::Object(m) => {
                let mut keys: Vec<&String> = m.keys().collect();
                keys.sort();
                let mut out = Map::new();
                for k in keys {
                    out.insert(k.clone(), canon(&m[k]));
                }
                Value::Object(out)
            }
            Value::Array(a) => Value::Array(a.iter().map(canon).collect()),
            other => other.clone(),
        }
    }
    canon(v).to_string()
}

/// hex(sha256(tool + "\n" + canonical args without `idempotency_key`)).
pub fn args_hash(tool: &str, args: &Value) -> String {
    let mut a = args.clone();
    if let Value::Object(m) = &mut a {
        m.remove("idempotency_key");
    }
    let mut h = Sha256::new();
    h.update(tool.as_bytes());
    h.update(b"\n");
    h.update(canonical_json(&a).as_bytes());
    hex::encode(h.finalize())
}

/// `derived:` + sha256 of the args hash and the target object's `updated_at`
/// (so the same call against a changed object is a different call).
pub fn derive_key(tool: &str, args: &Value, target_updated_at: Option<&str>) -> String {
    let mut h = Sha256::new();
    h.update(args_hash(tool, args).as_bytes());
    h.update(b"\n");
    h.update(target_updated_at.unwrap_or("").as_bytes());
    format!("{DERIVED_PREFIX}{}", hex::encode(h.finalize()))
}

pub fn append(conn: &Connection, e: NewEntry) -> ApiResult<JournalEntry> {
    let entry = JournalEntry {
        id: new_id(),
        ts: now(),
        actor: e.actor.to_string(),
        tool: e.tool.to_string(),
        args_json: e.args.clone(),
        result_json: e.result.clone(),
        approval_id: e.approval_id.map(String::from),
        idempotency_key: e.key.map(String::from),
        inverse_json: e.inverse.cloned(),
        undone_at: None,
        args_hash: e.args_hash.map(String::from),
    };
    conn.execute(
        &format!("INSERT INTO journal({COLS}) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,NULL,?10)"),
        params![
            entry.id,
            entry.ts,
            entry.actor,
            entry.tool,
            entry.args_json.to_string(),
            entry.result_json.to_string(),
            entry.approval_id,
            entry.idempotency_key,
            entry.inverse_json.as_ref().map(|v| v.to_string()),
            entry.args_hash,
        ],
    )?;
    Ok(entry)
}

pub fn get(conn: &Connection, id: &str) -> ApiResult<Option<JournalEntry>> {
    Ok(conn
        .query_row(
            &format!("SELECT {COLS} FROM journal WHERE id = ?1"),
            params![id],
            row,
        )
        .optional()?)
}

pub fn list(conn: &Connection, limit: usize) -> ApiResult<Vec<JournalEntry>> {
    let mut st = conn.prepare(&format!(
        "SELECT {COLS} FROM journal ORDER BY rowid DESC LIMIT ?1"
    ))?;
    let rows = st.query_map(params![limit as i64], row)?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// Look up a prior execution by idempotency key.
///
/// Explicit keys match forever. Derived keys match only within the 10 minute
/// window and only if the entry has not been undone; a stale derived key is
/// released (set to NULL) so the same call can run again.
pub fn find_by_key(conn: &Connection, key: &str) -> ApiResult<Option<JournalEntry>> {
    let found: Option<JournalEntry> = conn
        .query_row(
            &format!("SELECT {COLS} FROM journal WHERE idempotency_key = ?1"),
            params![key],
            row,
        )
        .optional()?;
    let Some(entry) = found else {
        return Ok(None);
    };
    if key.starts_with(DERIVED_PREFIX) && (!within_window(&entry.ts) || entry.undone_at.is_some()) {
        release_key(conn, &entry.id)?;
        return Ok(None);
    }
    Ok(Some(entry))
}

pub fn release_key(conn: &Connection, id: &str) -> ApiResult<()> {
    conn.execute(
        "UPDATE journal SET idempotency_key = NULL WHERE id = ?1",
        params![id],
    )?;
    Ok(())
}

fn within_window(ts: &str) -> bool {
    chrono::DateTime::parse_from_rfc3339(ts)
        .map(|t| chrono::Utc::now().signed_duration_since(t).num_seconds() <= DERIVED_WINDOW_SECS)
        .unwrap_or(false)
}

/// Most recent live (not undone, inside the window) execution of the same call.
pub fn find_recent_by_hash(
    conn: &Connection,
    tool: &str,
    hash: &str,
) -> ApiResult<Option<JournalEntry>> {
    let e: Option<JournalEntry> = conn
        .query_row(
            &format!(
                "SELECT {COLS} FROM journal WHERE tool = ?1 AND args_hash = ?2 AND undone_at IS NULL
                 ORDER BY rowid DESC LIMIT 1"
            ),
            params![tool, hash],
            row,
        )
        .optional()?;
    Ok(e.filter(|e| within_window(&e.ts)))
}

/// A live identical call whose result is the object's *current* state.
pub fn find_by_effect(
    conn: &Connection,
    tool: &str,
    hash: &str,
    updated_at: &str,
) -> ApiResult<Option<JournalEntry>> {
    let e = find_recent_by_hash(conn, tool, hash)?;
    Ok(e.filter(|e| {
        e.inverse_json
            .as_ref()
            .and_then(|i| i["after_updated_at"].as_str())
            == Some(updated_at)
    }))
}

/// Would `undo` succeed right now? A read-only mirror of its conflict checks.
fn undo_would_apply(conn: &Connection, e: &JournalEntry) -> bool {
    if e.tool == "undo" || e.undone_at.is_some() {
        return false;
    }
    let Some(inv) = &e.inverse_json else {
        return false;
    };
    match inv["op"].as_str() {
        Some("delete") | Some("restore") => {
            let (Some(id), Some(after)) = (inv["id"].as_str(), inv["after_updated_at"].as_str())
            else {
                return false;
            };
            matches!(tasks::get(conn, id), Ok(Some(t)) if t.updated_at == after)
        }
        Some("recreate") => inv["task"]["id"]
            .as_str()
            .is_some_and(|id| matches!(tasks::get(conn, id), Ok(None))),
        _ => false,
    }
}

/// Newest entry that has an inverse, is not undone and whose undo would not be
/// refused as stale.
pub fn latest_undoable(conn: &Connection) -> ApiResult<Option<JournalEntry>> {
    let mut st = conn.prepare(&format!(
        "SELECT {COLS} FROM journal
         WHERE inverse_json IS NOT NULL AND undone_at IS NULL AND tool != 'undo'
         ORDER BY rowid DESC"
    ))?;
    let rows = st.query_map([], row)?;
    for r in rows {
        let e = r?;
        if undo_would_apply(conn, &e) {
            return Ok(Some(e));
        }
    }
    Ok(None)
}

#[derive(Debug)]
pub struct UndoOutcome {
    pub original: JournalEntry,
    pub undo_entry: JournalEntry,
    /// `(op, task id, task)` describing the resulting task change.
    pub task_change: (String, String, Option<Task>),
}

/// Name the newest live journal entry (after `entry_id`) that touched `task_id`.
fn newer_entry_hint(conn: &Connection, entry_id: &str, task_id: &str) -> String {
    let hit: Option<(String, String)> = conn
        .query_row(
            "SELECT id, tool FROM journal
             WHERE rowid > (SELECT rowid FROM journal WHERE id = ?1)
               AND undone_at IS NULL AND tool != 'undo'
               AND (instr(result_json, ?2) > 0 OR instr(args_json, ?2) > 0)
             ORDER BY rowid DESC LIMIT 1",
            params![entry_id, task_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .ok()
        .flatten();
    match hit {
        Some((id, tool)) => format!("undo the newer entry {id} ({tool}) first"),
        None => "it was changed outside the journal".to_string(),
    }
}

/// Apply the inverse of a journal entry. Runs in a transaction.
///
/// Undo is conflict-safe: it only applies if the task is exactly as the entry
/// left it (`after_updated_at`); otherwise it fails with 409 `stale`.
pub fn undo(conn: &Connection, id: &str) -> ApiResult<UndoOutcome> {
    let tx = conn.unchecked_transaction()?;
    let entry = get(&tx, id)?
        .ok_or_else(|| ApiError::not_found(format!("journal entry '{id}' not found")))?;
    if entry.tool == "undo" {
        return Err(ApiError::conflict("undo of an undo is not supported"));
    }
    if entry.undone_at.is_some() {
        return Err(ApiError::conflict("entry was already undone"));
    }
    let inverse = entry
        .inverse_json
        .clone()
        .ok_or_else(|| ApiError::conflict("entry is not undoable"))?;
    let op = inverse["op"].as_str().unwrap_or_default().to_string();
    let corrupt = || ApiError::internal("corrupt inverse operation");
    let change = match op.as_str() {
        "delete" | "restore" => {
            let tid = inverse["id"].as_str().ok_or_else(corrupt)?.to_string();
            let after = inverse["after_updated_at"].as_str().ok_or_else(corrupt)?;
            let Some(mut task) = tasks::get(&tx, &tid)? else {
                return Err(ApiError::stale(format!(
                    "task no longer exists; {}",
                    newer_entry_hint(&tx, id, &tid)
                )));
            };
            if task.updated_at != after {
                return Err(ApiError::stale(format!(
                    "task changed since this entry; {}",
                    newer_entry_hint(&tx, id, &tid)
                )));
            }
            if op == "delete" {
                tasks::delete(&tx, &tid)?;
                ("deleted".to_string(), tid, None)
            } else {
                let before = inverse["before"].as_object().ok_or_else(corrupt)?;
                if let Some(v) = before.get("title").and_then(Value::as_str) {
                    task.title = v.to_string();
                }
                if let Some(v) = before.get("notes").and_then(Value::as_str) {
                    task.notes = v.to_string();
                }
                if let Some(v) = before.get("status").and_then(Value::as_str) {
                    task.status = v.to_string();
                }
                if let Some(v) = before.get("goal_id") {
                    task.goal_id = v.as_str().map(String::from);
                }
                task.updated_at = inverse["before_updated_at"]
                    .as_str()
                    .ok_or_else(corrupt)?
                    .to_string();
                tasks::replace(&tx, &task)?;
                ("updated".to_string(), tid, Some(task))
            }
        }
        "recreate" => {
            let t: Task = serde_json::from_value(inverse["task"].clone()).map_err(|_| corrupt())?;
            if tasks::get(&tx, &t.id)?.is_some() {
                return Err(ApiError::stale(
                    "a task with this id exists again; cannot undo",
                ));
            }
            tasks::insert(&tx, &t)?;
            ("created".to_string(), t.id.clone(), Some(t))
        }
        other => {
            return Err(ApiError::internal(format!("unknown inverse op '{other}'")));
        }
    };
    let undone_at = now();
    tx.execute(
        "UPDATE journal SET undone_at = ?2 WHERE id = ?1",
        params![id, undone_at],
    )?;
    let args = json!({"journal_id": id});
    let result = json!({"undone_tool": entry.tool, "op": op});
    let undo_entry = append(
        &tx,
        NewEntry {
            actor: "user",
            tool: "undo",
            args: &args,
            result: &result,
            approval_id: None,
            key: None,
            inverse: None,
            args_hash: None,
        },
    )?;
    let original = get(&tx, id)?.ok_or_else(|| ApiError::internal("journal entry vanished"))?;
    tx.commit()?;
    Ok(UndoOutcome {
        original,
        undo_entry,
        task_change: change,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;
    use crate::objects::tasks::{NewTask, TaskPatch};

    fn entry<'a>(
        args: &'a Value,
        res: &'a Value,
        key: Option<&'a str>,
        inv: Option<&'a Value>,
    ) -> NewEntry<'a> {
        NewEntry {
            actor: "agent",
            tool: "tasks_create",
            args,
            result: res,
            approval_id: None,
            key,
            inverse: inv,
            args_hash: None,
        }
    }

    #[test]
    fn canonical_and_derived_keys() {
        let a = json!({"b": 1, "a": {"y": 2, "x": [1, {"d": 1, "c": 2}]}});
        let b = json!({"a": {"x": [1, {"c": 2, "d": 1}], "y": 2}, "b": 1});
        assert_eq!(canonical_json(&a), canonical_json(&b));
        let mut c = a.clone();
        c["idempotency_key"] = json!("zzz");
        assert_eq!(args_hash("t", &a), args_hash("t", &c));
        assert_eq!(
            derive_key("t", &a, Some("1")),
            derive_key("t", &c, Some("1"))
        );
        assert_ne!(
            derive_key("t", &a, Some("1")),
            derive_key("t", &a, Some("2"))
        );
        assert_ne!(derive_key("t", &a, None), derive_key("u", &a, None));
        assert!(derive_key("t", &a, None).starts_with("derived:"));
    }

    #[test]
    fn append_list_and_unique_key() {
        let db = Db::open_memory().unwrap();
        let c = db.lock();
        let (a, r) = (json!({"x": 1}), json!({"ok": true}));
        let e1 = append(&c, entry(&a, &r, Some("k1"), None)).unwrap();
        append(&c, entry(&a, &r, None, None)).unwrap();
        append(&c, entry(&a, &r, None, None)).unwrap(); // NULL keys never conflict
        assert!(append(&c, entry(&a, &r, Some("k1"), None)).is_err());
        assert_eq!(list(&c, 2).unwrap().len(), 2);
        assert_eq!(find_by_key(&c, "k1").unwrap().unwrap().id, e1.id);
        assert!(find_by_key(&c, "nope").unwrap().is_none());
    }

    #[test]
    fn derived_key_expires_and_releases() {
        let db = Db::open_memory().unwrap();
        let c = db.lock();
        let (a, r) = (json!({}), json!({}));
        let key = derive_key("t", &a, None);
        let e = append(&c, entry(&a, &r, Some(&key), None)).unwrap();
        assert!(find_by_key(&c, &key).unwrap().is_some());
        let old = (chrono::Utc::now() - chrono::Duration::seconds(DERIVED_WINDOW_SECS + 5))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        c.execute(
            "UPDATE journal SET ts = ?1 WHERE id = ?2",
            params![old, e.id],
        )
        .unwrap();
        assert!(find_by_key(&c, &key).unwrap().is_none());
        append(&c, entry(&a, &r, Some(&key), None)).unwrap();
    }

    #[test]
    fn derived_key_ignored_after_undo_but_explicit_kept() {
        let db = Db::open_memory().unwrap();
        let c = db.lock();
        let (a, r) = (json!({}), json!({}));
        let dk = derive_key("t", &a, None);
        append(&c, entry(&a, &r, Some(&dk), None)).unwrap();
        let e2 = append(&c, entry(&a, &r, Some("explicit"), None)).unwrap();
        c.execute("UPDATE journal SET undone_at = 'x'", []).unwrap();
        assert!(find_by_key(&c, &dk).unwrap().is_none());
        assert_eq!(find_by_key(&c, "explicit").unwrap().unwrap().id, e2.id);
    }

    #[test]
    fn effect_lookup_matches_only_current_state() {
        let db = Db::open_memory().unwrap();
        let c = db.lock();
        let (a, r) = (json!({"id": "x"}), json!({}));
        let inv = json!({"op": "restore", "id": "x", "after_updated_at": "U1"});
        let mut ne = entry(&a, &r, None, Some(&inv));
        ne.args_hash = Some("h");
        append(&c, ne).unwrap();
        assert!(find_by_effect(&c, "tasks_create", "h", "U1")
            .unwrap()
            .is_some());
        assert!(find_by_effect(&c, "tasks_create", "h", "U2")
            .unwrap()
            .is_none());
        assert!(find_recent_by_hash(&c, "tasks_create", "other")
            .unwrap()
            .is_none());
    }

    fn journal_op(c: &Connection, tool: &str, inv: Value) -> JournalEntry {
        append(
            c,
            NewEntry {
                actor: "agent",
                tool,
                args: &json!({}),
                result: &json!({}),
                approval_id: None,
                key: None,
                inverse: Some(&inv),
                args_hash: None,
            },
        )
        .unwrap()
    }

    fn mk(c: &Connection, title: &str) -> Task {
        tasks::create(
            c,
            NewTask {
                title: title.into(),
                ..Default::default()
            },
        )
        .unwrap()
    }

    #[test]
    fn undo_create_update_delete() {
        let db = Db::open_memory().unwrap();
        let c = db.lock();
        let t = mk(&c, "a");
        let j = journal_op(
            &c,
            "tasks_create",
            json!({"op": "delete", "id": t.id, "after_updated_at": t.updated_at}),
        );
        let out = undo(&c, &j.id).unwrap();
        assert!(out.original.undone_at.is_some());
        assert_eq!(out.undo_entry.tool, "undo");
        assert!(tasks::get(&c, &t.id).unwrap().is_none());
        assert_eq!(undo(&c, &j.id).unwrap_err().status, 409);
        assert_eq!(undo(&c, &out.undo_entry.id).unwrap_err().status, 409);

        let t = mk(&c, "b");
        let (before, after) = tasks::update(
            &c,
            &t.id,
            TaskPatch {
                title: Some("b2".into()),
                ..Default::default()
            },
        )
        .unwrap();
        let j = journal_op(
            &c,
            "tasks_update",
            json!({"op": "restore", "id": t.id, "before": {"title": "b"},
                   "before_updated_at": before.updated_at, "after_updated_at": after.updated_at}),
        );
        undo(&c, &j.id).unwrap();
        assert_eq!(tasks::get(&c, &t.id).unwrap().unwrap(), before);

        let before = tasks::delete(&c, &t.id).unwrap();
        let j = journal_op(
            &c,
            "tasks_delete",
            json!({"op": "recreate", "task": before}),
        );
        let out = undo(&c, &j.id).unwrap();
        assert_eq!(out.task_change.0, "created");
        assert_eq!(tasks::get(&c, &t.id).unwrap().unwrap(), before);
        let j = journal_op(
            &c,
            "tasks_delete",
            json!({"op": "recreate", "task": before}),
        );
        let e = undo(&c, &j.id).unwrap_err();
        assert_eq!((e.status.as_u16(), e.code), (409, "stale"));
    }

    #[test]
    fn undo_is_stale_after_later_edit_and_names_newer_entry() {
        let db = Db::open_memory().unwrap();
        let c = db.lock();
        let t = mk(&c, "a");
        let j1 = journal_op(
            &c,
            "tasks_create",
            json!({"op": "delete", "id": t.id, "after_updated_at": t.updated_at}),
        );
        // a later journaled edit by someone else
        let (_, after) = tasks::update(
            &c,
            &t.id,
            TaskPatch {
                notes: Some("hand written".into()),
                ..Default::default()
            },
        )
        .unwrap();
        let args = json!({"id": t.id});
        let j2 = append(
            &c,
            NewEntry {
                actor: "user",
                tool: "tasks_update",
                args: &args,
                result: &json!({}),
                approval_id: None,
                key: None,
                inverse: Some(
                    &json!({"op": "restore", "id": t.id, "before": {"notes": ""},
                    "before_updated_at": t.updated_at, "after_updated_at": after.updated_at}),
                ),
                args_hash: None,
            },
        )
        .unwrap();
        let e = undo(&c, &j1.id).unwrap_err();
        assert_eq!((e.status.as_u16(), e.code), (409, "stale"));
        assert!(e.message.contains(&j2.id), "{}", e.message);
        assert_eq!(
            tasks::get(&c, &t.id).unwrap().unwrap().notes,
            "hand written"
        );
        // undoing the newer one first makes the older undoable again
        undo(&c, &j2.id).unwrap();
        undo(&c, &j1.id).unwrap();
        assert!(tasks::get(&c, &t.id).unwrap().is_none());
    }

    #[test]
    fn undo_errors() {
        let db = Db::open_memory().unwrap();
        let c = db.lock();
        assert_eq!(undo(&c, "missing").unwrap_err().status, 404);
        let e = append(&c, entry(&json!({}), &json!({}), None, None)).unwrap();
        assert_eq!(undo(&c, &e.id).unwrap_err().status, 409);
        let j = journal_op(
            &c,
            "tasks_create",
            json!({"op": "delete", "id": "ghost", "after_updated_at": "x"}),
        );
        assert_eq!(undo(&c, &j.id).unwrap_err().code, "stale");
        let j = journal_op(&c, "x", json!({"op": "weird"}));
        assert_eq!(undo(&c, &j.id).unwrap_err().status, 500);
    }
}
