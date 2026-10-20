//! Task objects.

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

use crate::db::{new_id, now};
use crate::error::{ApiError, ApiResult};

pub const STATUSES: [&str; 4] = ["todo", "doing", "blocked", "done"];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Task {
    pub id: String,
    pub title: String,
    pub notes: String,
    pub status: String,
    pub goal_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Default, Clone, Deserialize)]
pub struct NewTask {
    pub title: String,
    pub notes: Option<String>,
    pub status: Option<String>,
    pub goal_id: Option<String>,
}

#[derive(Debug, Default, Clone, Deserialize)]
pub struct TaskPatch {
    pub title: Option<String>,
    pub notes: Option<String>,
    pub status: Option<String>,
    pub goal_id: Option<String>,
}

impl TaskPatch {
    pub fn is_empty(&self) -> bool {
        self.title.is_none()
            && self.notes.is_none()
            && self.status.is_none()
            && self.goal_id.is_none()
    }
}

const COLS: &str = "id, title, notes, status, goal_id, created_at, updated_at";

fn row(r: &Row) -> rusqlite::Result<Task> {
    Ok(Task {
        id: r.get(0)?,
        title: r.get(1)?,
        notes: r.get(2)?,
        status: r.get(3)?,
        goal_id: r.get(4)?,
        created_at: r.get(5)?,
        updated_at: r.get(6)?,
    })
}

pub fn validate_title(title: &str) -> ApiResult<String> {
    let t = title.trim();
    if t.is_empty() {
        return Err(ApiError::bad_request("title must not be empty"));
    }
    if t.chars().count() > 500 {
        return Err(ApiError::bad_request(
            "title must be at most 500 characters",
        ));
    }
    Ok(t.to_string())
}

pub fn validate_status(status: &str) -> ApiResult<()> {
    if STATUSES.contains(&status) {
        Ok(())
    } else {
        Err(ApiError::bad_request(format!(
            "invalid status '{status}' (expected one of: {})",
            STATUSES.join(", ")
        )))
    }
}

pub fn list(conn: &Connection, status: Option<&str>) -> ApiResult<Vec<Task>> {
    let mut out = Vec::new();
    match status {
        Some(s) => {
            validate_status(s)?;
            let mut st = conn.prepare(&format!(
                "SELECT {COLS} FROM tasks WHERE status = ?1 ORDER BY rowid"
            ))?;
            for t in st.query_map(params![s], row)? {
                out.push(t?);
            }
        }
        None => {
            let mut st = conn.prepare(&format!("SELECT {COLS} FROM tasks ORDER BY rowid"))?;
            for t in st.query_map([], row)? {
                out.push(t?);
            }
        }
    }
    Ok(out)
}

pub fn get(conn: &Connection, id: &str) -> ApiResult<Option<Task>> {
    Ok(conn
        .query_row(
            &format!("SELECT {COLS} FROM tasks WHERE id = ?1"),
            params![id],
            row,
        )
        .optional()?)
}

pub fn require(conn: &Connection, id: &str) -> ApiResult<Task> {
    get(conn, id)?.ok_or_else(|| ApiError::not_found(format!("task '{id}' not found")))
}

pub fn create(conn: &Connection, new: NewTask) -> ApiResult<Task> {
    let title = validate_title(&new.title)?;
    let status = new.status.unwrap_or_else(|| "todo".into());
    validate_status(&status)?;
    let ts = now();
    let task = Task {
        id: new_id(),
        title,
        notes: new.notes.unwrap_or_default(),
        status,
        goal_id: new.goal_id,
        created_at: ts.clone(),
        updated_at: ts,
    };
    insert(conn, &task)?;
    Ok(task)
}

/// Insert a fully specified task (used by create and by undo-of-delete).
pub fn insert(conn: &Connection, t: &Task) -> ApiResult<()> {
    conn.execute(
        &format!("INSERT INTO tasks({COLS}) VALUES (?1,?2,?3,?4,?5,?6,?7)"),
        params![
            t.id,
            t.title,
            t.notes,
            t.status,
            t.goal_id,
            t.created_at,
            t.updated_at
        ],
    )?;
    Ok(())
}

/// Overwrite a task with a stored snapshot (used by undo-of-update).
pub fn replace(conn: &Connection, t: &Task) -> ApiResult<()> {
    let n = conn.execute(
        "UPDATE tasks SET title=?2, notes=?3, status=?4, goal_id=?5, created_at=?6, updated_at=?7
         WHERE id=?1",
        params![
            t.id,
            t.title,
            t.notes,
            t.status,
            t.goal_id,
            t.created_at,
            t.updated_at
        ],
    )?;
    if n == 0 {
        return Err(ApiError::conflict(format!(
            "task '{}' no longer exists",
            t.id
        )));
    }
    Ok(())
}

/// Returns (before, after).
pub fn update(conn: &Connection, id: &str, patch: TaskPatch) -> ApiResult<(Task, Task)> {
    if patch.is_empty() {
        return Err(ApiError::bad_request("no fields to update"));
    }
    let before = require(conn, id)?;
    let mut after = before.clone();
    if let Some(t) = &patch.title {
        after.title = validate_title(t)?;
    }
    if let Some(n) = patch.notes {
        after.notes = n;
    }
    if let Some(s) = patch.status {
        validate_status(&s)?;
        after.status = s;
    }
    if let Some(g) = patch.goal_id {
        after.goal_id = Some(g);
    }
    after.updated_at = now();
    replace(conn, &after)?;
    Ok((before, after))
}

pub fn delete(conn: &Connection, id: &str) -> ApiResult<Task> {
    let before = require(conn, id)?;
    conn.execute("DELETE FROM tasks WHERE id = ?1", params![id])?;
    Ok(before)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;

    fn mk(title: &str) -> NewTask {
        NewTask {
            title: title.into(),
            ..Default::default()
        }
    }

    #[test]
    fn create_list_get() {
        let db = Db::open_memory().unwrap();
        let c = db.lock();
        let t = create(&c, mk("  buy milk ")).unwrap();
        assert_eq!(t.title, "buy milk");
        assert_eq!(t.status, "todo");
        assert_eq!(list(&c, None).unwrap().len(), 1);
        assert_eq!(list(&c, Some("done")).unwrap().len(), 0);
        assert_eq!(get(&c, &t.id).unwrap().unwrap(), t);
    }

    #[test]
    fn validation() {
        let db = Db::open_memory().unwrap();
        let c = db.lock();
        assert_eq!(create(&c, mk("  ")).unwrap_err().status, 400);
        let mut n = mk("x");
        n.status = Some("nope".into());
        assert_eq!(create(&c, n).unwrap_err().status, 400);
        assert_eq!(list(&c, Some("nope")).unwrap_err().status, 400);
    }

    #[test]
    fn update_and_delete() {
        let db = Db::open_memory().unwrap();
        let c = db.lock();
        let t = create(&c, mk("a")).unwrap();
        let (b, a) = update(
            &c,
            &t.id,
            TaskPatch {
                status: Some("done".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(b.status, "todo");
        assert_eq!(a.status, "done");
        assert!(update(&c, &t.id, TaskPatch::default()).is_err());
        assert_eq!(
            update(
                &c,
                "missing",
                TaskPatch {
                    title: Some("x".into()),
                    ..Default::default()
                }
            )
            .unwrap_err()
            .status,
            404
        );
        let del = delete(&c, &t.id).unwrap();
        assert_eq!(del.status, "done");
        assert_eq!(delete(&c, &t.id).unwrap_err().status, 404);
        insert(&c, &del).unwrap();
        assert_eq!(get(&c, &t.id).unwrap().unwrap(), del);
    }
}
