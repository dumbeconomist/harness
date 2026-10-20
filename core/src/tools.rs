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
#[serde(deny_unknown_fields)]
struct ListArgs {
    status: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateArgs {
    title: String,
    notes: Option<String>,
    status: Option<String>,
    #[allow(dead_code)]
    idempotency_key: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct UpdateArgs {
    id: String,
    title: Option<String>,
    notes: Option<String>,
    status: Option<String>,
    #[allow(dead_code)]
    idempotency_key: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DeleteArgs {
    id: String,
    #[allow(dead_code)]
    idempotency_key: Option<String>,
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
                goal_id: None,
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
                    goal_id: None,
                },
            )?;
            Ok(Executed {
                result: json!({"task": t}),
                inverse: Some(
                    json!({"op": "delete", "id": t.id, "after_updated_at": t.updated_at}),
                ),
                change: Some(("created", t.id.clone(), Some(t))),
            })
        }
        "tasks_update" => {
            let a: UpdateArgs = parse_args(args)?;
            let patch = TaskPatch {
                title: a.title,
                notes: a.notes,
                status: a.status,
                goal_id: None,
            };
            // Field-level "before": only the fields this call touches.
            let (has_title, has_notes, has_status, has_goal) = (
                patch.title.is_some(),
                patch.notes.is_some(),
                patch.status.is_some(),
                patch.goal_id.is_some(),
            );
            let (before, after) = tasks::update(conn, &a.id, patch)?;
            let mut fields = serde_json::Map::new();
            if has_title {
                fields.insert("title".into(), json!(before.title));
            }
            if has_notes {
                fields.insert("notes".into(), json!(before.notes));
            }
            if has_status {
                fields.insert("status".into(), json!(before.status));
            }
            if has_goal {
                fields.insert("goal_id".into(), json!(before.goal_id));
            }
            Ok(Executed {
                result: json!({"task": after}),
                inverse: Some(json!({
                    "op": "restore",
                    "id": after.id,
                    "before": fields,
                    "before_updated_at": before.updated_at,
                    "after_updated_at": after.updated_at,
                })),
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

pub const SHUTDOWN_NOTE: &str = "server shutting down";

const KEY_REUSED: &str = "idempotency key reused with different arguments";

/// Execute a write tool and journal it atomically. Emits events afterwards.
pub fn execute_journaled(
    state: &SharedState,
    tool: &str,
    args: &Value,
    actor: &str,
    approval_id: Option<&str>,
    key: Option<&str>,
) -> ApiResult<Journaled> {
    let hash = journal::args_hash(tool, args);
    let outcome = state.db.with(|conn| {
        if let Some(k) = key {
            if let Some(prev) = journal::find_by_key(conn, k)? {
                if prev.tool != tool || prev.args_hash.as_deref().is_some_and(|h| h != hash) {
                    return Err(ApiError::conflict(KEY_REUSED));
                }
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
                args_hash: Some(&hash),
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
        tracing::info!(tool = %tool, actor = %actor, journal_id = %journaled.entry.id, "tool executed");
        state
            .events
            .emit("journal.appended", json!(journaled.entry));
    }
    Ok(journaled)
}

enum Pre {
    Replay(Value),
    Go {
        summary: String,
        policy: policy::Policy,
        key: String,
    },
}

/// Decide whether this call replays an earlier one, and compute the key under
/// which a fresh execution will be journaled.
fn idempotency(
    conn: &Connection,
    tool: &str,
    args: &Value,
    hash: &str,
) -> ApiResult<Result<String, Value>> {
    if let Some(k) = args
        .get("idempotency_key")
        .and_then(Value::as_str)
        .filter(|k| !k.is_empty())
    {
        return match journal::find_by_key(conn, k)? {
            Some(prev) => {
                if prev.tool != tool || prev.args_hash.as_deref().is_some_and(|h| h != hash) {
                    Err(ApiError::bad_request(KEY_REUSED))
                } else {
                    Ok(Err(prev.result_json))
                }
            }
            None => Ok(Ok(k.to_string())),
        };
    }
    if tool == "tasks_create" {
        let key = journal::derive_key(tool, args, None);
        if let Some(prev) = journal::find_by_key(conn, &key)? {
            // Only a replay while the created object still exists, unchanged.
            let created = &prev.result_json["task"];
            let same = created["id"]
                .as_str()
                .and_then(|id| tasks::get(conn, id).ok().flatten())
                .is_some_and(|t| Some(t.updated_at.as_str()) == created["updated_at"].as_str());
            if same {
                return Ok(Err(prev.result_json));
            }
            journal::release_key(conn, &prev.id)?;
        }
        return Ok(Ok(key));
    }
    // update / delete: bound to the target's current state.
    let id = args.get("id").and_then(Value::as_str).unwrap_or_default();
    match tasks::get(conn, id)? {
        Some(t) => {
            let key = journal::derive_key(tool, args, Some(&t.updated_at));
            if let Some(prev) = journal::find_by_key(conn, &key)? {
                return Ok(Err(prev.result_json));
            }
            // A retry of a call that already produced the current state.
            if tool == "tasks_update" {
                if let Some(prev) = journal::find_by_effect(conn, tool, hash, &t.updated_at)? {
                    return Ok(Err(prev.result_json));
                }
            }
            Ok(Ok(key))
        }
        None => {
            // Object gone: a retry of a delete we just did is a replay.
            if tool == "tasks_delete" {
                if let Some(prev) = journal::find_recent_by_hash(conn, tool, hash)? {
                    return Ok(Err(prev.result_json));
                }
            }
            Err(ApiError::not_found(format!("task '{id}' not found")))
        }
    }
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

    // 1. Validate (no side effects), switch, policy, idempotency: one lock.
    let hash = journal::args_hash(name, &args);
    let pre = state.db.with(|conn| {
        match prepare(conn, name, &args) {
            Ok(()) => {}
            Err(e) if e.status == 404 && name == "tasks_delete" => {
                // possibly a retry of a delete that already happened
                if let Some(prev) = journal::find_recent_by_hash(conn, name, &hash)? {
                    return Ok(Pre::Replay(prev.result_json));
                }
                return Err(e);
            }
            Err(e) => return Err(e),
        }
        if let Some(sw) = def.switch {
            if !policy::switch_enabled(conn, sw)? {
                return Err(ApiError::forbidden(format!(
                    "permission switch '{sw}' is off; the user must enable it in Settings"
                )));
            }
        }
        if def.tier == 0 {
            return Ok(Pre::Go {
                summary: String::new(),
                policy: policy::Policy::Ask,
                key: String::new(),
            });
        }
        let key = match idempotency(conn, name, &args, &hash)? {
            Ok(k) => k,
            Err(stored) => return Ok(Pre::Replay(stored)),
        };
        Ok(Pre::Go {
            summary: summarize(conn, name, &args),
            policy: policy::effective_policy(conn, name)?,
            key,
        })
    });
    let (summary, pol, key) = match pre {
        Ok(Pre::Go {
            summary,
            policy,
            key,
        }) => (summary, policy, key),
        Ok(Pre::Replay(v)) => return Ok(ToolResult::Ok(v)),
        Err(e) => return Ok(e.into()),
    };

    // Tier 0: read and return.
    if def.tier == 0 {
        return Ok(match state.db.with(|c| exec(c, name, &args)) {
            Ok(ex) => ToolResult::Ok(ex.result),
            Err(e) => e.into(),
        });
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
                let why = if decided.note.as_deref() == Some(SHUTDOWN_NOTE) {
                    "Workbench is shutting down".to_string()
                } else {
                    format!(
                        "no decision within {}s",
                        state.config.approval_timeout.as_secs()
                    )
                };
                return Ok(ToolResult::Error(format!(
                    "Approval expired: {why}. Nothing was changed."
                )));
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
        let inv = ex.inverse.unwrap();
        assert_eq!(inv["before"]["status"], "todo");
        assert!(inv["after_updated_at"].is_string());
        let ex = exec(&c, "tasks_list", &json!({"status": "done"})).unwrap();
        assert_eq!(ex.result["tasks"].as_array().unwrap().len(), 1);
        let ex = exec(&c, "tasks_delete", &json!({"id": id})).unwrap();
        assert_eq!(ex.inverse.unwrap()["op"], "recreate");
        assert!(summarize(&c, "tasks_create", &json!({"title": "q"})).contains("q"));
    }
}
