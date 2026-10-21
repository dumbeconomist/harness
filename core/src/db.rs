//! SQLite access: a single connection behind a mutex, migrations, small helpers.

use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard};

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;

use crate::error::ApiResult;

const MIGRATIONS: &[&str] = &[
    r#"
CREATE TABLE tasks(
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','doing','blocked','done')),
  goal_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE approvals(
  id TEXT PRIMARY KEY,
  tool TEXT NOT NULL,
  tier INTEGER NOT NULL,
  args_json TEXT NOT NULL,
  summary TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','approved','denied','expired')),
  requested_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  decided_at TEXT,
  note TEXT
);
CREATE INDEX approvals_status ON approvals(status);
CREATE TABLE journal(
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  actor TEXT NOT NULL CHECK (actor IN ('agent','user')),
  tool TEXT NOT NULL,
  args_json TEXT NOT NULL,
  result_json TEXT NOT NULL,
  approval_id TEXT,
  idempotency_key TEXT UNIQUE,
  inverse_json TEXT,
  undone_at TEXT
);
CREATE TABLE ledger(
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  run_id TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL,
  completion_tokens INTEGER NOT NULL,
  cost_usd REAL NOT NULL,
  source TEXT NOT NULL
);
CREATE TABLE settings(
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL
);
"#,
    "ALTER TABLE journal ADD COLUMN args_hash TEXT;",
    r#"
CREATE TABLE threads(
  id TEXT PRIMARY KEY,
  context_kind TEXT,
  context_id TEXT,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX threads_context ON threads(context_kind, context_id);
CREATE TABLE messages(
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user','assistant','tool')),
  content TEXT NOT NULL,
  tool_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX messages_thread ON messages(thread_id);
"#,
    "ALTER TABLE messages ADD COLUMN status TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','failed','partial'));",
];

#[derive(Clone)]
pub struct Db(Arc<Mutex<Connection>>);

impl Db {
    pub fn open(path: &Path) -> anyhow::Result<Db> {
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        Self::init(conn)
    }

    pub fn open_memory() -> anyhow::Result<Db> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(mut conn: Connection) -> anyhow::Result<Db> {
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        migrate(&mut conn)?;
        Ok(Db(Arc::new(Mutex::new(conn))))
    }

    pub fn lock(&self) -> MutexGuard<'_, Connection> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Run a closure with the connection locked.
    pub fn with<T>(&self, f: impl FnOnce(&Connection) -> ApiResult<T>) -> ApiResult<T> {
        let guard = self.lock();
        f(&guard)
    }
}

fn migrate(conn: &mut Connection) -> anyhow::Result<()> {
    let current: usize = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
    for (i, sql) in MIGRATIONS.iter().enumerate().skip(current) {
        let tx = conn.transaction()?;
        tx.execute_batch(sql)?;
        tx.pragma_update(None, "user_version", (i + 1) as i64)?;
        tx.commit()?;
    }
    Ok(())
}

pub fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

pub fn new_id() -> String {
    uuid::Uuid::now_v7().to_string()
}

pub fn get_setting(conn: &Connection, key: &str) -> ApiResult<Option<Value>> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT value_json FROM settings WHERE key = ?1",
            params![key],
            |r| r.get(0),
        )
        .optional()?;
    Ok(match raw {
        Some(s) => Some(serde_json::from_str(&s)?),
        None => None,
    })
}

pub fn set_setting(conn: &Connection, key: &str, value: &Value) -> ApiResult<()> {
    conn.execute(
        "INSERT INTO settings(key, value_json) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json",
        params![key, serde_json::to_string(value)?],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrates_and_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("t.db");
        {
            Db::open(&p).unwrap();
        }
        let db = Db::open(&p).unwrap();
        let v: i64 = db
            .lock()
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .unwrap();
        assert_eq!(v, MIGRATIONS.len() as i64);
        let n: i64 = db
            .lock()
            .query_row("SELECT count(*) FROM tasks", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn settings_roundtrip() {
        let db = Db::open_memory().unwrap();
        let c = db.lock();
        assert!(get_setting(&c, "k").unwrap().is_none());
        set_setting(&c, "k", &serde_json::json!({"a": 1})).unwrap();
        set_setting(&c, "k", &serde_json::json!({"a": 2})).unwrap();
        assert_eq!(get_setting(&c, "k").unwrap().unwrap()["a"], 2);
    }

    #[test]
    fn ids_and_timestamps() {
        assert_ne!(new_id(), new_id());
        assert!(now().ends_with('Z'));
    }

    #[test]
    fn status_check_constraint() {
        let db = Db::open_memory().unwrap();
        let c = db.lock();
        let r = c.execute(
            "INSERT INTO tasks(id,title,status,created_at,updated_at) VALUES('a','t','bogus','x','x')",
            [],
        );
        assert!(r.is_err());
    }
}
