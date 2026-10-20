//! App API for the UI (`/api/*`) and router assembly.

use std::collections::HashMap;
use std::convert::Infallible;
use std::time::Duration;

use axum::extract::{FromRequest, Path, Query, Request, State};
use axum::http::{header, HeaderValue, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::sse::{Event as SseEvent, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use axum::{Json, Router};
use futures::{Stream, StreamExt};
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio_stream::wrappers::{BroadcastStream, ReceiverStream};
use tower_http::cors::{AllowHeaders, AllowOrigin, CorsLayer};

use crate::approvals;
use crate::brain::{BrainEvent, ChatMessage, ChatRequest};
use crate::db::new_id;
use crate::error::{ApiError, ApiResult};
use crate::journal;
use crate::ledger;
use crate::mcp;
use crate::objects::tasks;
use crate::policy;
use crate::state::SharedState;
use crate::tools;

// ---------------------------------------------------------------- helpers

/// JSON body extractor whose rejection uses the `{error:{code,message}}` shape.
pub struct ApiJson<T>(pub T);

#[axum::async_trait]
impl<S: Send + Sync, T: DeserializeOwned> FromRequest<S> for ApiJson<T> {
    type Rejection = ApiError;
    async fn from_request(req: Request, state: &S) -> Result<Self, ApiError> {
        let bytes = axum::body::Bytes::from_request(req, state)
            .await
            .map_err(|e| ApiError::bad_request(format!("could not read body: {e}")))?;
        serde_json::from_slice(&bytes)
            .map(ApiJson)
            .map_err(|e| ApiError::bad_request(format!("invalid JSON body: {e}")))
    }
}

/// Is this a browser origin we trust (localhost UIs and the Tauri webview)?
pub fn origin_is_local(origin: &str) -> bool {
    if origin == "tauri://localhost" {
        return true;
    }
    for prefix in ["http://localhost", "http://127.0.0.1", "http://[::1]"] {
        if let Some(rest) = origin.strip_prefix(prefix) {
            if rest.is_empty() {
                return true;
            }
            if let Some(port) = rest.strip_prefix(':') {
                return !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit());
            }
        }
    }
    false
}

fn ct_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn limit_param(q: &HashMap<String, String>, default: usize) -> ApiResult<usize> {
    match q.get("limit") {
        None => Ok(default),
        Some(s) => s
            .parse::<usize>()
            .ok()
            .filter(|n| *n >= 1)
            .map(|n| n.min(1000))
            .ok_or_else(|| ApiError::bad_request("limit must be a positive integer")),
    }
}

// ------------------------------------------------------------------- auth

async fn auth(State(st): State<SharedState>, req: Request, next: Next) -> Response {
    let bearer_ok = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(|t| ct_eq(t.trim(), &st.token))
        .unwrap_or(false);
    let query_ok = req.uri().path() == "/api/events"
        && req
            .uri()
            .query()
            .and_then(|q| q.split('&').find_map(|kv| kv.strip_prefix("token=")))
            .map(|t| ct_eq(t, &st.token))
            .unwrap_or(false);
    if !(bearer_ok || query_ok) {
        return ApiError::unauthorized().into_response();
    }
    next.run(req).await
}

// ----------------------------------------------------------------- router

pub fn router(state: SharedState) -> Router {
    let protected = Router::new()
        .route("/api/tasks", get(list_tasks).post(create_task))
        .route("/api/tasks/:id", patch(update_task).delete(delete_task))
        .route("/api/approvals", get(list_approvals))
        .route("/api/approvals/:id/decision", post(decide_approval))
        .route("/api/journal", get(list_journal))
        .route("/api/journal/:id/undo", post(undo_journal))
        .route("/api/ledger/summary", get(ledger_summary))
        .route("/api/ledger/entries", get(ledger_entries))
        .route(
            "/api/settings/permissions",
            get(get_permissions).put(put_permissions),
        )
        .route(
            "/api/settings/policies",
            get(get_policies).put(put_policies),
        )
        .route("/api/chat", post(chat))
        .route("/api/events", get(events))
        .route(
            "/mcp",
            post(mcp::post_mcp)
                .get(mcp::method_not_allowed)
                .delete(mcp::delete_session),
        )
        .layer(middleware::from_fn_with_state(state.clone(), auth));

    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::predicate(|origin: &HeaderValue, _| {
            origin.to_str().map(origin_is_local).unwrap_or(false)
        }))
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::PATCH,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers(AllowHeaders::mirror_request())
        .max_age(Duration::from_secs(600));

    Router::new()
        .route("/api/health", get(health))
        .merge(protected)
        .fallback(|| async { ApiError::not_found("no such route") })
        .layer(cors)
        .with_state(state)
}

// ----------------------------------------------------------------- health

async fn health(State(st): State<SharedState>) -> Json<Value> {
    let url = format!("{}/models", st.config.hermes_url.trim_end_matches('/'));
    let mut rb = st.http.get(url).timeout(Duration::from_millis(1500));
    if let Some(k) = &st.config.hermes_api_key {
        rb = rb.bearer_auth(k);
    }
    // Any HTTP answer (even 401) means the server is up.
    let reachable = rb.send().await.is_ok();
    Json(json!({
        "ok": true,
        "version": env!("CARGO_PKG_VERSION"),
        "hermes": {"reachable": reachable},
    }))
}

// ------------------------------------------------------------------ tasks

async fn list_tasks(
    State(st): State<SharedState>,
    Query(q): Query<HashMap<String, String>>,
) -> ApiResult<Json<Vec<tasks::Task>>> {
    let status = q.get("status").cloned();
    Ok(Json(st.db.with(|c| tasks::list(c, status.as_deref()))?))
}

fn task_from_result(v: &Value) -> ApiResult<Value> {
    v.get("task")
        .cloned()
        .ok_or_else(|| ApiError::internal("missing task in result"))
}

async fn create_task(
    State(st): State<SharedState>,
    ApiJson(body): ApiJson<Value>,
) -> ApiResult<Json<Value>> {
    if !body.is_object() {
        return Err(ApiError::bad_request("expected a JSON object"));
    }
    let j = tools::execute_journaled(&st, "tasks_create", &body, "user", None, None)?;
    Ok(Json(task_from_result(&j.entry.result_json)?))
}

async fn update_task(
    State(st): State<SharedState>,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<Value>,
) -> ApiResult<Json<Value>> {
    let mut args = body
        .as_object()
        .cloned()
        .ok_or_else(|| ApiError::bad_request("expected a JSON object"))?;
    args.insert("id".into(), json!(id));
    let j = tools::execute_journaled(
        &st,
        "tasks_update",
        &Value::Object(args),
        "user",
        None,
        None,
    )?;
    Ok(Json(task_from_result(&j.entry.result_json)?))
}

async fn delete_task(
    State(st): State<SharedState>,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    tools::execute_journaled(&st, "tasks_delete", &json!({"id": id}), "user", None, None)?;
    Ok(StatusCode::NO_CONTENT)
}

// -------------------------------------------------------------- approvals

async fn list_approvals(
    State(st): State<SharedState>,
    Query(q): Query<HashMap<String, String>>,
) -> ApiResult<Json<Vec<approvals::Approval>>> {
    let status = q.get("status").cloned();
    Ok(Json(st.db.with(|c| approvals::list(c, status.as_deref()))?))
}

#[derive(Deserialize)]
struct DecisionBody {
    decision: String,
    note: Option<String>,
}

async fn decide_approval(
    State(st): State<SharedState>,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<DecisionBody>,
) -> ApiResult<Json<approvals::Approval>> {
    let approve = match body.decision.as_str() {
        "approve" => true,
        "deny" => false,
        _ => {
            return Err(ApiError::bad_request(
                "decision must be \"approve\" or \"deny\"",
            ))
        }
    };
    Ok(Json(st.approvals.decide(
        &id,
        approve,
        body.note.as_deref(),
    )?))
}

// ---------------------------------------------------------------- journal

async fn list_journal(
    State(st): State<SharedState>,
    Query(q): Query<HashMap<String, String>>,
) -> ApiResult<Json<Vec<journal::JournalEntry>>> {
    let limit = limit_param(&q, 50)?;
    Ok(Json(st.db.with(|c| journal::list(c, limit))?))
}

async fn undo_journal(
    State(st): State<SharedState>,
    Path(id): Path<String>,
) -> ApiResult<Json<journal::JournalEntry>> {
    let out = st.db.with(|c| journal::undo(c, &id))?;
    let (op, tid, task) = &out.task_change;
    st.events
        .emit("task.changed", json!({"op": op, "id": tid, "task": task}));
    st.events.emit("journal.undone", json!(out.original));
    st.events.emit("journal.appended", json!(out.undo_entry));
    Ok(Json(out.original))
}

// ----------------------------------------------------------------- ledger

async fn ledger_summary(State(st): State<SharedState>) -> ApiResult<Json<ledger::Summary>> {
    Ok(Json(st.db.with(ledger::summary)?))
}

async fn ledger_entries(
    State(st): State<SharedState>,
    Query(q): Query<HashMap<String, String>>,
) -> ApiResult<Json<Vec<ledger::LedgerEntry>>> {
    let limit = limit_param(&q, 100)?;
    Ok(Json(st.db.with(|c| ledger::entries(c, limit))?))
}

// --------------------------------------------------------------- settings

async fn get_permissions(State(st): State<SharedState>) -> ApiResult<Json<Value>> {
    Ok(Json(Value::Object(st.db.with(policy::get_permissions)?)))
}

async fn put_permissions(
    State(st): State<SharedState>,
    ApiJson(body): ApiJson<Value>,
) -> ApiResult<Json<Value>> {
    Ok(Json(Value::Object(
        st.db.with(|c| policy::set_permissions(c, &body))?,
    )))
}

async fn get_policies(State(st): State<SharedState>) -> ApiResult<Json<Value>> {
    Ok(Json(Value::Object(st.db.with(policy::get_policies)?)))
}

async fn put_policies(
    State(st): State<SharedState>,
    ApiJson(body): ApiJson<Value>,
) -> ApiResult<Json<Value>> {
    Ok(Json(Value::Object(
        st.db.with(|c| policy::set_policies(c, &body))?,
    )))
}

// ----------------------------------------------------------------- events

async fn events(
    State(st): State<SharedState>,
) -> Sse<impl Stream<Item = Result<SseEvent, Infallible>>> {
    let rx = st.events.subscribe();
    let mut shutdown = st.shutdown.clone();
    let live = BroadcastStream::new(rx).filter_map(|r| async move {
        // A lagged receiver just skips what it missed.
        let ev = r.ok()?;
        let data = serde_json::to_string(&ev).ok()?;
        Some(Ok(SseEvent::default().data(data)))
    });
    let hello = futures::stream::once(async { Ok(SseEvent::default().comment("connected")) });
    let stream = hello.chain(live).take_until(async move {
        let _ = shutdown.wait_for(|v| *v).await;
    });
    Sse::new(stream).keep_alive(KeepAlive::default())
}

// ------------------------------------------------------------------- chat

#[derive(Deserialize)]
struct ChatBody {
    messages: Vec<ChatMessage>,
    context: Option<ChatContext>,
    session_id: Option<String>,
}

#[derive(Deserialize)]
struct ChatContext {
    kind: String,
    id: String,
}

fn sse_json(name: &str, v: Value) -> Result<SseEvent, Infallible> {
    Ok(SseEvent::default().event(name).data(v.to_string()))
}

async fn chat(
    State(st): State<SharedState>,
    ApiJson(body): ApiJson<ChatBody>,
) -> ApiResult<Response> {
    if body.messages.is_empty() {
        return Err(ApiError::bad_request("messages must not be empty"));
    }
    for m in &body.messages {
        if !["system", "user", "assistant"].contains(&m.role.as_str()) {
            return Err(ApiError::bad_request(format!("invalid role '{}'", m.role)));
        }
    }
    let mut messages = body.messages;
    if let Some(ctx) = &body.context {
        if ctx.kind == "task" {
            if let Some(t) = st.db.with(|c| tasks::get(c, &ctx.id))? {
                messages.insert(
                    0,
                    ChatMessage {
                        role: "system".into(),
                        content: format!(
                            "The user is looking at this Workbench task: {}",
                            serde_json::to_string(&t).unwrap_or_default()
                        ),
                    },
                );
            }
        }
    }

    let mut upstream = st.brain.chat_stream(ChatRequest {
        messages,
        model: None,
        session_id: body.session_id,
    });
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<SseEvent, Infallible>>(64);
    let run_id = new_id();
    tokio::spawn(async move {
        while let Some(ev) = upstream.next().await {
            let out = match ev {
                BrainEvent::Delta(text) => sse_json("delta", json!({"text": text})),
                BrainEvent::ToolProgress { tool, status } => {
                    sse_json("tool", json!({"tool": tool, "status": status}))
                }
                BrainEvent::Error(message) => {
                    let _ = tx
                        .send(sse_json("error", json!({"message": message})))
                        .await;
                    break;
                }
                BrainEvent::Done { usage, model } => {
                    let rec = st.db.with(|c| {
                        ledger::record(
                            c,
                            &run_id,
                            &model,
                            usage.prompt_tokens,
                            usage.completion_tokens,
                        )
                    });
                    let cost = match rec {
                        Ok(entry) => {
                            st.events.emit("ledger.appended", json!(entry));
                            entry.cost_usd
                        }
                        Err(e) => {
                            tracing::error!("failed to record ledger entry: {e}");
                            0.0
                        }
                    };
                    let _ = tx
                        .send(sse_json(
                            "done",
                            json!({
                                "usage": {
                                    "prompt_tokens": usage.prompt_tokens,
                                    "completion_tokens": usage.completion_tokens,
                                    "total_tokens": usage.prompt_tokens + usage.completion_tokens,
                                    "cost_usd": cost,
                                },
                                "model": model,
                                "run_id": run_id,
                            }),
                        ))
                        .await;
                    break;
                }
            };
            if tx.send(out).await.is_err() {
                break; // client went away
            }
        }
    });
    Ok(Sse::new(ReceiverStream::new(rx))
        .keep_alive(KeepAlive::default())
        .into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origins() {
        for ok in [
            "http://localhost",
            "http://localhost:5173",
            "http://127.0.0.1:8765",
            "tauri://localhost",
            "http://[::1]:3000",
        ] {
            assert!(origin_is_local(ok), "{ok}");
        }
        for bad in [
            "http://evil.com",
            "http://localhost.evil.com",
            "http://localhost:abc",
            "http://localhost:",
            "https://localhost:3000",
            "http://127.0.0.1.evil.com:80",
            "null",
        ] {
            assert!(!origin_is_local(bad), "{bad}");
        }
    }

    #[test]
    fn constant_time_eq() {
        assert!(ct_eq("abc", "abc"));
        assert!(!ct_eq("abc", "abd"));
        assert!(!ct_eq("abc", "ab"));
    }

    #[test]
    fn limits() {
        let mut q = HashMap::new();
        assert_eq!(limit_param(&q, 50).unwrap(), 50);
        q.insert("limit".into(), "5".into());
        assert_eq!(limit_param(&q, 50).unwrap(), 5);
        q.insert("limit".into(), "0".into());
        assert!(limit_param(&q, 50).is_err());
        q.insert("limit".into(), "x".into());
        assert!(limit_param(&q, 50).is_err());
    }
}
