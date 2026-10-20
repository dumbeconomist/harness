//! Append-only journal of writes: idempotency keys and undo via inverse ops.

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::Serialize;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use crate::db::{new_id, now};
use crate::error::{ApiError, ApiResult};
use crate::objects::tasks::{self, Task};

/// Derived idempotency keys are only honoured for this long.
pub const DERIVED_WINDOW_SECS: i64 = 600;
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
}

pub struct NewEntry<'a> {
    pub actor: &'a str,
    pub tool: &'a str,
    pub args: &'a Value,
    pub result: &'a Value,
    pub approval_id: Option<&'a str>,
    pub key: Option<&'a str>,
    pub inverse: Option<&'a Value>,
}

const COLS: &str =
    "id, ts, actor, tool, args_json, result_json, approval_id, idempotency_key, inverse_json, undone_at";

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

/// `derived:` + hex(sha256(tool + "\n" + canonical args without `idempotency_key`)).
pub fn derive_key(tool: &str, args: &Value) -> String {
    let mut a = args.clone();
    if let Value::Object(m) = &mut a {
        m.remove("idempotency_key");
    }
    let mut h = Sha256::new();
    h.update(tool.as_bytes());
    h.update(b"\n");
    h.update(canonical_json(&a).as_bytes());
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
    };
    conn.execute(
        &format!("INSERT INTO journal({COLS}) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,NULL)"),
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
    if key.starts_with(DERIVED_PREFIX) {
        let age = chrono::DateTime::parse_from_rfc3339(&entry.ts)
            .map(|t| chrono::Utc::now().signed_duration_since(t).num_seconds())
            .unwrap_or(i64::MAX);
        if age > DERIVED_WINDOW_SECS || entry.undone_at.is_some() {
            conn.execute(
                "UPDATE journal SET idempotency_key = NULL WHERE id = ?1",
                params![entry.id],
            )?;
            return Ok(None);
        }
    }
    Ok(Some(entry))
}

#[derive(Debug)]
pub struct UndoOutcome {
    pub original: JournalEntry,
    pub undo_entry: JournalEntry,
    /// `(op, task id, task)` describing the resulting task change.
    pub task_change: (String, String, Option<Task>),
}

/// Apply the inverse of a journal entry. Runs in a transaction.
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
    let task_from = |v: &Value| -> ApiResult<Task> {
        serde_json::from_value(v["task"].clone())
            .map_err(|_| ApiError::internal("corrupt inverse operation"))
    };
    let change = match op.as_str() {
        "delete" => {
            let tid = inverse["id"].as_str().unwrap_or_default().to_string();
            if tasks::get(&tx, &tid)?.is_none() {
                return Err(ApiError::conflict("task no longer exists; cannot undo"));
            }
            tasks::delete(&tx, &tid)?;
            ("deleted".to_string(), tid, None)
        }
        "restore" => {
            let t = task_from(&inverse)?;
            tasks::replace(&tx, &t)?;
            ("updated".to_string(), t.id.clone(), Some(t))
        }
        "recreate" => {
            let t = task_from(&inverse)?;
            if tasks::get(&tx, &t.id)?.is_some() {
                return Err(ApiError::conflict("task already exists; cannot undo"));
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
        }
    }

    #[test]
    fn canonical_and_derived_keys_ignore_order_and_idem_key() {
        let a = json!({"b": 1, "a": {"y": 2, "x": [1, {"d": 1, "c": 2}]}});
        let b = json!({"a": {"x": [1, {"c": 2, "d": 1}], "y": 2}, "b": 1});
        assert_eq!(canonical_json(&a), canonical_json(&b));
        let mut c = a.clone();
        c["idempotency_key"] = json!("zzz");
        assert_eq!(derive_key("t", &a), derive_key("t", &c));
        assert_ne!(derive_key("t", &a), derive_key("u", &a));
        assert!(derive_key("t", &a).starts_with("derived:"));
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
        let l = list(&c, 2).unwrap();
        assert_eq!(l.len(), 2);
        assert_eq!(
            get(&c, &e1.id).unwrap().unwrap().idempotency_key.as_deref(),
            Some("k1")
        );
        assert_eq!(find_by_key(&c, "k1").unwrap().unwrap().id, e1.id);
        assert!(find_by_key(&c, "nope").unwrap().is_none());
    }

    #[test]
    fn derived_key_expires_and_releases() {
        let db = Db::open_memory().unwrap();
        let c = db.lock();
        let (a, r) = (json!({}), json!({}));
        let key = derive_key("t", &a);
        let e = append(&c, entry(&a, &r, Some(&key), None)).unwrap();
        assert!(find_by_key(&c, &key).unwrap().is_some());
        // age it past the window
        let old = (chrono::Utc::now() - chrono::Duration::seconds(DERIVED_WINDOW_SECS + 5))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        c.execute(
            "UPDATE journal SET ts = ?1 WHERE id = ?2",
            params![old, e.id],
        )
        .unwrap();
        assert!(find_by_key(&c, &key).unwrap().is_none());
        // key was released, so it can be reused
        append(&c, entry(&a, &r, Some(&key), None)).unwrap();
    }

    #[test]
    fn derived_key_ignored_after_undo_but_explicit_kept() {
        let db = Db::open_memory().unwrap();
        let c = db.lock();
        let (a, r) = (json!({}), json!({}));
        let dk = derive_key("t", &a);
        let e1 = append(&c, entry(&a, &r, Some(&dk), None)).unwrap();
        let e2 = append(&c, entry(&a, &r, Some("explicit"), None)).unwrap();
        c.execute("UPDATE journal SET undone_at = 'x'", []).unwrap();
        assert!(find_by_key(&c, &dk).unwrap().is_none());
        assert_eq!(find_by_key(&c, "explicit").unwrap().unwrap().id, e2.id);
        let _ = e1;
    }

    fn journal_task_op(c: &Connection, tool: &str, inv: Value) -> JournalEntry {
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
            },
        )
        .unwrap()
    }

    #[test]
    fn undo_create_update_delete() {
        let db = Db::open_memory().unwrap();
        let c = db.lock();
        // create
        let t = tasks::create(
            &c,
            NewTask {
                title: "a".into(),
                ..Default::default()
            },
        )
        .unwrap();
        let j = journal_task_op(&c, "tasks_create", json!({"op": "delete", "id": t.id}));
        let out = undo(&c, &j.id).unwrap();
        assert!(out.original.undone_at.is_some());
        assert_eq!(out.undo_entry.tool, "undo");
        assert!(tasks::get(&c, &t.id).unwrap().is_none());
        // double undo -> 409
        assert_eq!(undo(&c, &j.id).unwrap_err().status, 409);
        // undo of undo -> 409
        assert_eq!(undo(&c, &out.undo_entry.id).unwrap_err().status, 409);

        // update
        let t = tasks::create(
            &c,
            NewTask {
                title: "b".into(),
                ..Default::default()
            },
        )
        .unwrap();
        let (before, _) = tasks::update(
            &c,
            &t.id,
            TaskPatch {
                title: Some("b2".into()),
                ..Default::default()
            },
        )
        .unwrap();
        let j = journal_task_op(&c, "tasks_update", json!({"op": "restore", "task": before}));
        undo(&c, &j.id).unwrap();
        assert_eq!(tasks::get(&c, &t.id).unwrap().unwrap(), before);

        // delete
        let before = tasks::delete(&c, &t.id).unwrap();
        let j = journal_task_op(
            &c,
            "tasks_delete",
            json!({"op": "recreate", "task": before}),
        );
        let out = undo(&c, &j.id).unwrap();
        assert_eq!(out.task_change.0, "created");
        assert_eq!(tasks::get(&c, &t.id).unwrap().unwrap(), before);
        // recreate when exists -> 409 (new entry)
        let j = journal_task_op(
            &c,
            "tasks_delete",
            json!({"op": "recreate", "task": before}),
        );
        assert_eq!(undo(&c, &j.id).unwrap_err().status, 409);
    }

    #[test]
    fn undo_errors() {
        let db = Db::open_memory().unwrap();
        let c = db.lock();
        assert_eq!(undo(&c, "missing").unwrap_err().status, 404);
        let e = append(&c, entry(&json!({}), &json!({}), None, None)).unwrap();
        assert_eq!(undo(&c, &e.id).unwrap_err().status, 409);
        let j = journal_task_op(&c, "tasks_create", json!({"op": "delete", "id": "ghost"}));
        assert_eq!(undo(&c, &j.id).unwrap_err().status, 409);
        let j = journal_task_op(&c, "x", json!({"op": "weird"}));
        assert_eq!(undo(&c, &j.id).unwrap_err().status, 500);
    }
}
