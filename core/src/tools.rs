//! Tool execution: the single path through which agent (and user) writes happen.
//!
//! Flow for agent calls (see architecture.md "tools/call flow"):
//! validate -> idempotency -> permission switch -> policy gate -> approval ->
//! execute + journal (atomic).

use rusqlite::Connection;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::{ApiError, ApiResult};
use crate::journal::{self, JournalEntry, NewEntry};
use crate::objects::tasks::{self, NewTask, Task, TaskPatch};
use crate::policy::{self, Gate};
use crate::state::SharedState;

/// Outcome of an agent tool call, before MCP formatting.
#[derive(Debug, Clone, PartialEq)]
pub enum ToolResult {
    Ok(Value),
    Error(String),
}

impl From<ApiError> for ToolResult {
    fn from(e: ApiError) -> Self {
        ToolResult::Error(e.message)
    }
}

#[derive(Deserialize)]
struct ListArgs {
    status: Option<String>,
}
#[derive(Deserialize)]
struct CreateArgs {
    title: String,
    notes: Option<String>,
    status: Option<String>,
    goal_id: Option<String>,
}
#[derive(Deserialize)]
struct UpdateArgs {
    id: String,
    title: Option<String>,
    notes: Option<String>,
    status: Option<String>,
    goal_id: Option<String>,
}
#[derive(Deserialize)]
struct DeleteArgs {
    id: String,
}

fn parse_args<T: serde::de::DeserializeOwned>(args: &Value) -> ApiResult<T> {
    serde_json::from_value(args.clone())
        .map_err(|e| ApiError::bad_request(format!("invalid arguments: {e}")))
}

/// JSON Schema for a tool's input.
pub fn input_schema(tool: &str) -> Value {
    let status = json!({"type": "string", "enum": tasks::STATUSES});
    let idem = json!({"type": "string", "description": "Optional idempotency key; repeating a call with the same key returns the first result without executing again."});
    match tool {
        "tasks_list" => json!({
            "type": "object",
            "properties": {"status": status},
            "additionalProperties": false
        }),
        "tasks_create" => json!({
            "type": "object",
            "properties": {
                "title": {"type": "string", "minLength": 1, "maxLength": 500},
                "notes": {"type": "string"},
                "status": status,
                "idempotency_key": idem
            },
            "required": ["title"],
            "additionalProperties": false
        }),
        "tasks_update" => json!({
            "type": "object",
            "properties": {
                "id": {"type": "string"},
                "title": {"type": "string", "minLength": 1, "maxLength": 500},
                "notes": {"type": "string"},
                "status": status,
                "idempotency_key": idem
            },
            "required": ["id"],
            "additionalProperties": false
        }),
        "tasks_delete" => json!({
            "type": "object",
            "properties": {"id": {"type": "string"}, "idempotency_key": idem},
            "required": ["id"],
            "additionalProperties": false
        }),
        _ => json!({"type": "object"}),
    }
}

/// Validate arguments and preconditions without side effects.
fn prepare(conn: &Connection, tool: &str, args: &Value) -> ApiResult<()> {
    match tool {
        "tasks_list" => {
            let a: ListArgs = parse_args(args)?;
            if let Some(s) = a.status {
                tasks::validate_status(&s)?;
            }
        }
        "tasks_create" => {
            let a: CreateArgs = parse_args(args)?;
            tasks::validate_title(&a.title)?;
            if let Some(s) = a.status {
                tasks::validate_status(&s)?;
            }
        }
        "tasks_update" => {
            let a: UpdateArgs = parse_args(args)?;
            let patch = TaskPatch {
                title: a.title,
                notes: a.notes,
                status: a.status,
                goal_id: a.goal_id,
            };
            if patch.is_empty() {
                return Err(ApiError::bad_request("no fields to update"));
            }
            if let Some(t) = &patch.title {
                tasks::validate_title(t)?;
            }
            if let Some(s) = &patch.status {
                tasks::validate_status(s)?;
            }
            tasks::require(conn, &a.id)?;
        }
        "tasks_delete" => {
            let a: DeleteArgs = parse_args(args)?;
            tasks::require(conn, &a.id)?;
        }
        other => return Err(ApiError::bad_request(format!("unknown tool '{other}'"))),
    }
    Ok(())
}

fn summarize(conn: &Connection, tool: &str, args: &Value) -> String {
    let s = |k: &str| {
        args.get(k)
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    };
    match tool {
        "tasks_create" => format!("Create task \"{}\"", s("title")),
        "tasks_update" => {
            let name = tasks::get(conn, &s("id"))
                .ok()
                .flatten()
                .map(|t| t.title)
                .unwrap_or_else(|| s("id"));
            let mut fields: Vec<&str> = ["title", "notes", "status"]
                .into_iter()
                .filter(|k| args.get(*k).is_some())
                .collect();
            if fields.is_empty() {
                fields.push("nothing");
            }
            format!("Update task \"{name}\" ({})", fields.join(", "))
        }
        "tasks_delete" => {
            let name = tasks::get(conn, &s("id"))
                .ok()
                .flatten()
                .map(|t| t.title)
                .unwrap_or_else(|| s("id"));
            format!("Delete task \"{name}\"")
        }
        other => format!("Run {other}"),
    }
}

struct Executed {
    result: Value,
    inverse: Option<Value>,
    /// `(op, task)` for the `task.changed` event.
    change: Option<(&'static str, String, Option<Task>)>,
}

fn exec(conn: &Connection, tool: &str, args: &Value) -> ApiResult<Executed> {
    match tool {
        "tasks_list" => {
            let a: ListArgs = parse_args(args)?;
            let list = tasks::list(conn, a.status.as_deref())?;
            Ok(Executed {
                result: json!({"tasks": list}),
                inverse: None,
                change: None,
            })
        }
        "tasks_create" => {
            let a: CreateArgs = parse_args(args)?;
            let t = tasks::create(
                conn,
                NewTask {
                    title: a.title,
                    notes: a.notes,
                    status: a.status,
                    goal_id: a.goal_id,
                },
            )?;
            Ok(Executed {
                result: json!({"task": t}),
                inverse: Some(json!({"op": "delete", "id": t.id})),
                change: Some(("created", t.id.clone(), Some(t))),
            })
        }
        "tasks_update" => {
            let a: UpdateArgs = parse_args(args)?;
            let (before, after) = tasks::update(
                conn,
                &a.id,
                TaskPatch {
                    title: a.title,
                    notes: a.notes,
                    status: a.status,
                    goal_id: a.goal_id,
                },
            )?;
            Ok(Executed {
                result: json!({"task": after}),
                inverse: Some(json!({"op": "restore", "task": before})),
                change: Some(("updated", after.id.clone(), Some(after))),
            })
        }
        "tasks_delete" => {
            let a: DeleteArgs = parse_args(args)?;
            let before = tasks::delete(conn, &a.id)?;
            Ok(Executed {
                result: json!({"deleted": true, "id": before.id}),
                inverse: Some(json!({"op": "recreate", "task": before})),
                change: Some(("deleted", before.id.clone(), None)),
            })
        }
        other => Err(ApiError::bad_request(format!("unknown tool '{other}'"))),
    }
}

#[derive(Debug)]
pub struct Journaled {
    pub entry: JournalEntry,
    /// True when an earlier execution with the same idempotency key was returned.
    pub replayed: bool,
}

/// Execute a write tool and journal it atomically. Emits events afterwards.
pub fn execute_journaled(
    state: &SharedState,
    tool: &str,
    args: &Value,
    actor: &str,
    approval_id: Option<&str>,
    key: Option<&str>,
) -> ApiResult<Journaled> {
    let outcome = state.db.with(|conn| {
        if let Some(k) = key {
            if let Some(prev) = journal::find_by_key(conn, k)? {
                return Ok((
                    Journaled {
                        entry: prev,
                        replayed: true,
                    },
                    None,
                ));
            }
        }
        let tx = conn.unchecked_transaction()?;
        let ex = exec(&tx, tool, args)?;
        let entry = journal::append(
            &tx,
            NewEntry {
                actor,
                tool,
                args,
                result: &ex.result,
                approval_id,
                key,
                inverse: ex.inverse.as_ref(),
            },
        )?;
        tx.commit()?;
        Ok((
            Journaled {
                entry,
                replayed: false,
            },
            ex.change,
        ))
    })?;
    let (journaled, change) = outcome;
    if let Some((op, id, task)) = change {
        state
            .events
            .emit("task.changed", json!({"op": op, "id": id, "task": task}));
    }
    if !journaled.replayed {
        state
            .events
            .emit("journal.appended", json!(journaled.entry));
    }
    Ok(journaled)
}

/// Handle an MCP `tools/call`. `Err` means "unknown tool" (a protocol error);
/// everything else is a tool result.
pub async fn call(state: &SharedState, name: &str, args: Value) -> Result<ToolResult, ApiError> {
    let def = policy::tool(name)
        .ok_or_else(|| ApiError::bad_request(format!("unknown tool '{name}'")))?;
    let args = if args.is_null() { json!({}) } else { args };
    if !args.is_object() {
        return Ok(ToolResult::Error("arguments must be an object".into()));
    }

    // 1. Validate (no side effects) + summary + switch + policy, under one lock.
    let pre = state.db.with(|conn| {
        prepare(conn, name, &args)?;
        if let Some(sw) = def.switch {
            if !policy::switch_enabled(conn, sw)? {
                return Err(ApiError::forbidden(format!(
                    "permission switch '{sw}' is off; the user must enable it in Settings"
                )));
            }
        }
        let pol = policy::effective_policy(conn, name)?;
        Ok((summarize(conn, name, &args), pol))
    });
    let (summary, pol) = match pre {
        Ok(v) => v,
        Err(e) => return Ok(e.into()),
    };

    // Tier 0: read and return.
    if def.tier == 0 {
        return Ok(match state.db.with(|c| exec(c, name, &args)) {
            Ok(ex) => ToolResult::Ok(ex.result),
            Err(e) => e.into(),
        });
    }

    // 2. Idempotency.
    let key = args
        .get("idempotency_key")
        .and_then(Value::as_str)
        .filter(|k| !k.is_empty())
        .map(String::from)
        .unwrap_or_else(|| journal::derive_key(name, &args));
    match state.db.with(|c| journal::find_by_key(c, &key)) {
        Ok(Some(prev)) => return Ok(ToolResult::Ok(prev.result_json)),
        Ok(None) => {}
        Err(e) => return Ok(e.into()),
    }

    // 3. Gate.
    let mut approval_id = None;
    if policy::gate(def.tier, pol) == Gate::Ask {
        let approval = match state
            .approvals
            .create(name, def.tier, &args, &summary, "agent")
        {
            Ok(a) => a,
            Err(e) => return Ok(e.into()),
        };
        let decided = match state
            .approvals
            .wait(&approval.id, state.config.approval_timeout)
            .await
        {
            Ok(a) => a,
            Err(e) => return Ok(e.into()),
        };
        match decided.status.as_str() {
            "approved" => approval_id = Some(decided.id),
            "denied" => {
                let note = decided
                    .note
                    .filter(|n| !n.is_empty())
                    .unwrap_or_else(|| "no reason given".into());
                return Ok(ToolResult::Error(format!("Denied by user: {note}")));
            }
            _ => {
                return Ok(ToolResult::Error(format!(
                    "Approval expired: no decision within {}s. Nothing was changed.",
                    state.config.approval_timeout.as_secs()
                )))
            }
        }
    }

    // 4. Execute + journal.
    Ok(
        match execute_journaled(
            state,
            name,
            &args,
            "agent",
            approval_id.as_deref(),
            Some(&key),
        ) {
            Ok(j) => ToolResult::Ok(j.entry.result_json),
            Err(e) => e.into(),
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;

    #[test]
    fn schemas_are_objects_with_required() {
        for t in policy::TOOLS {
            let s = input_schema(t.name);
            assert_eq!(s["type"], "object", "{}", t.name);
        }
        assert_eq!(input_schema("tasks_create")["required"][0], "title");
        assert_eq!(input_schema("tasks_update")["required"][0], "id");
    }

    #[test]
    fn prepare_validates() {
        let db = Db::open_memory().unwrap();
        let c = db.lock();
        assert!(prepare(&c, "tasks_create", &json!({})).is_err());
        assert!(prepare(&c, "tasks_create", &json!({"title": ""})).is_err());
        assert!(prepare(&c, "tasks_create", &json!({"title": "x", "status": "zzz"})).is_err());
        assert!(prepare(
            &c,
            "tasks_create",
            &json!({"title": "x", "idempotency_key": "k"})
        )
        .is_ok());
        assert!(prepare(&c, "tasks_update", &json!({"id": "nope", "title": "x"})).is_err());
        assert!(prepare(&c, "tasks_update", &json!({"id": "nope"})).is_err());
        assert!(prepare(&c, "tasks_delete", &json!({"id": "nope"})).is_err());
        assert!(prepare(&c, "bogus", &json!({})).is_err());
    }

    #[test]
    fn exec_roundtrip_and_inverse() {
        let db = Db::open_memory().unwrap();
        let c = db.lock();
        let ex = exec(&c, "tasks_create", &json!({"title": "a"})).unwrap();
        let id = ex.result["task"]["id"].as_str().unwrap().to_string();
        assert_eq!(ex.inverse.unwrap()["op"], "delete");
        let ex = exec(&c, "tasks_update", &json!({"id": id, "status": "done"})).unwrap();
        assert_eq!(ex.inverse.unwrap()["task"]["status"], "todo");
        let ex = exec(&c, "tasks_list", &json!({"status": "done"})).unwrap();
        assert_eq!(ex.result["tasks"].as_array().unwrap().len(), 1);
        let ex = exec(&c, "tasks_delete", &json!({"id": id})).unwrap();
        assert_eq!(ex.inverse.unwrap()["op"], "recreate");
        assert!(summarize(&c, "tasks_create", &json!({"title": "q"})).contains("q"));
    }
}
