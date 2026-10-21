//! Chat threads and their persisted messages.

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::Serialize;
use serde_json::Value;

use crate::db::{new_id, now};
use crate::error::{ApiError, ApiResult};

pub const DEFAULT_TITLE: &str = "New thread";

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Thread {
    pub id: String,
    pub context_kind: Option<String>,
    pub context_id: Option<String>,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Message {
    pub id: String,
    pub thread_id: String,
    pub role: String,
    pub content: String,
    pub tool_json: Option<Value>,
    pub created_at: String,
}

const THREAD_COLS: &str = "id, context_kind, context_id, title, created_at, updated_at";

fn thread_row(r: &Row) -> rusqlite::Result<Thread> {
    Ok(Thread {
        id: r.get(0)?,
        context_kind: r.get(1)?,
        context_id: r.get(2)?,
        title: r.get(3)?,
        created_at: r.get(4)?,
        updated_at: r.get(5)?,
    })
}

fn message_row(r: &Row) -> rusqlite::Result<Message> {
    let tool: Option<String> = r.get(4)?;
    Ok(Message {
        id: r.get(0)?,
        thread_id: r.get(1)?,
        role: r.get(2)?,
        content: r.get(3)?,
        tool_json: tool.and_then(|s| serde_json::from_str(&s).ok()),
        created_at: r.get(5)?,
    })
}

pub fn create(
    conn: &Connection,
    context_kind: Option<&str>,
    context_id: Option<&str>,
    title: Option<&str>,
) -> ApiResult<Thread> {
    let title = title
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .unwrap_or(DEFAULT_TITLE);
    let ts = now();
    let t = Thread {
        id: new_id(),
        context_kind: context_kind.map(String::from),
        context_id: context_id.map(String::from),
        title: title.chars().take(200).collect(),
        created_at: ts.clone(),
        updated_at: ts,
    };
    conn.execute(
        "INSERT INTO threads(id, context_kind, context_id, title, created_at, updated_at)
         VALUES (?1,?2,?3,?4,?5,?6)",
        params![
            t.id,
            t.context_kind,
            t.context_id,
            t.title,
            t.created_at,
            t.updated_at
        ],
    )?;
    Ok(t)
}

pub fn get(conn: &Connection, id: &str) -> ApiResult<Option<Thread>> {
    Ok(conn
        .query_row(
            &format!("SELECT {THREAD_COLS} FROM threads WHERE id = ?1"),
            params![id],
            thread_row,
        )
        .optional()?)
}

/// Newest (by creation) first; each filter applies only when given.
pub fn list(
    conn: &Connection,
    context_kind: Option<&str>,
    context_id: Option<&str>,
) -> ApiResult<Vec<Thread>> {
    let mut st = conn.prepare(&format!(
        "SELECT {THREAD_COLS} FROM threads
         WHERE (?1 IS NULL OR context_kind = ?1) AND (?2 IS NULL OR context_id = ?2)
         ORDER BY rowid DESC"
    ))?;
    let rows = st.query_map(params![context_kind, context_id], thread_row)?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub fn delete(conn: &Connection, id: &str) -> ApiResult<()> {
    let n = conn.execute("DELETE FROM threads WHERE id = ?1", params![id])?;
    if n == 0 {
        return Err(ApiError::not_found(format!("thread '{id}' not found")));
    }
    Ok(())
}

/// Oldest first.
pub fn messages(conn: &Connection, thread_id: &str) -> ApiResult<Vec<Message>> {
    let mut st = conn.prepare(
        "SELECT id, thread_id, role, content, tool_json, created_at
         FROM messages WHERE thread_id = ?1 ORDER BY rowid",
    )?;
    let rows = st.query_map(params![thread_id], message_row)?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// Append a message and bump the thread's `updated_at`.
pub fn add_message(
    conn: &Connection,
    thread_id: &str,
    role: &str,
    content: &str,
    tool_json: Option<&Value>,
) -> ApiResult<Message> {
    let m = Message {
        id: new_id(),
        thread_id: thread_id.to_string(),
        role: role.to_string(),
        content: content.to_string(),
        tool_json: tool_json.cloned(),
        created_at: now(),
    };
    conn.execute(
        "INSERT INTO messages(id, thread_id, role, content, tool_json, created_at)
         VALUES (?1,?2,?3,?4,?5,?6)",
        params![
            m.id,
            m.thread_id,
            m.role,
            m.content,
            tool_json.map(|v| v.to_string()),
            m.created_at
        ],
    )?;
    conn.execute(
        "UPDATE threads SET updated_at = ?2 WHERE id = ?1",
        params![thread_id, m.created_at],
    )?;
    Ok(m)
}

/// Give a still-untitled thread a title taken from its first user message.
pub fn auto_title(conn: &Connection, thread_id: &str, text: &str) -> ApiResult<()> {
    let title: String = text
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(60)
        .collect();
    if title.is_empty() {
        return Ok(());
    }
    conn.execute(
        "UPDATE threads SET title = ?2 WHERE id = ?1 AND title = ?3",
        params![thread_id, title, DEFAULT_TITLE],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;

    #[test]
    fn crud_filter_cascade_and_order() {
        let db = Db::open_memory().unwrap();
        let c = db.lock();
        let a = create(&c, Some("task"), Some("t1"), None).unwrap();
        let b = create(&c, None, None, Some("  Hi  ")).unwrap();
        assert_eq!(a.title, DEFAULT_TITLE);
        assert_eq!(b.title, "Hi");
        let all = list(&c, None, None).unwrap();
        assert_eq!(
            all.iter().map(|t| &t.id).collect::<Vec<_>>(),
            [&b.id, &a.id]
        );
        assert_eq!(list(&c, Some("task"), Some("t1")).unwrap().len(), 1);
        assert_eq!(list(&c, Some("task"), Some("zz")).unwrap().len(), 0);
        add_message(&c, &a.id, "user", "one", None).unwrap();
        add_message(&c, &a.id, "assistant", "two", None).unwrap();
        let ms = messages(&c, &a.id).unwrap();
        assert_eq!(ms[0].content, "one");
        assert_eq!(ms[1].content, "two");
        auto_title(&c, &a.id, "  buy   milk and eggs ").unwrap();
        assert_eq!(get(&c, &a.id).unwrap().unwrap().title, "buy milk and eggs");
        auto_title(&c, &a.id, "later").unwrap();
        assert_eq!(get(&c, &a.id).unwrap().unwrap().title, "buy milk and eggs");
        delete(&c, &a.id).unwrap();
        assert!(messages(&c, &a.id).unwrap().is_empty());
        assert_eq!(delete(&c, &a.id).unwrap_err().status.as_u16(), 404);
    }
}
