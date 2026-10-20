//! MCP server: JSON-RPC 2.0 over streamable HTTP (single JSON responses).

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{json, Value};

use crate::policy;
use crate::state::SharedState;
use crate::tools::{self, ToolResult};

pub const PROTOCOL_VERSION: &str = "2025-06-18";
const SUPPORTED_VERSIONS: [&str; 2] = ["2025-06-18", "2025-11-25"];

pub const PARSE_ERROR: i64 = -32700;
pub const INVALID_REQUEST: i64 = -32600;
pub const METHOD_NOT_FOUND: i64 = -32601;
pub const INVALID_PARAMS: i64 = -32602;

fn rpc_error(id: Value, code: i64, message: impl Into<String>) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message.into()}})
}

fn rpc_result(id: Value, result: Value) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "result": result})
}

pub fn tools_list() -> Value {
    let tools: Vec<Value> = policy::TOOLS
        .iter()
        .map(|t| {
            json!({
                "name": t.name,
                "description": format!("{} (risk tier {})", t.description, t.tier),
                "inputSchema": tools::input_schema(t.name),
            })
        })
        .collect();
    json!({"tools": tools})
}

fn format_tool_result(r: ToolResult) -> Value {
    match r {
        ToolResult::Ok(v) => json!({
            "content": [{"type": "text", "text": v.to_string()}],
            "structuredContent": v,
        }),
        ToolResult::Error(msg) => json!({
            "isError": true,
            "content": [{"type": "text", "text": msg}],
        }),
    }
}

/// Handle one decoded JSON-RPC message. `None` means "no response" (notification).
pub async fn handle_message(state: &SharedState, msg: Value) -> Option<Value> {
    let Some(obj) = msg.as_object() else {
        return Some(rpc_error(
            Value::Null,
            INVALID_REQUEST,
            "request must be a JSON object",
        ));
    };
    if obj.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return Some(rpc_error(
            obj.get("id").cloned().unwrap_or(Value::Null),
            INVALID_REQUEST,
            "jsonrpc must be \"2.0\"",
        ));
    }
    let method = obj.get("method").and_then(Value::as_str);
    let id = obj.get("id").cloned();
    let Some(method) = method else {
        // A response or malformed message from the client: ignore responses.
        if obj.contains_key("result") || obj.contains_key("error") {
            return None;
        }
        return Some(rpc_error(
            id.unwrap_or(Value::Null),
            INVALID_REQUEST,
            "missing method",
        ));
    };
    let Some(id) = id else {
        // Notification (initialized, cancelled, ...): nothing to answer.
        return None;
    };
    let params = obj.get("params").cloned().unwrap_or(Value::Null);

    Some(match method {
        "initialize" => {
            let requested = params.get("protocolVersion").and_then(Value::as_str);
            let version = requested
                .filter(|v| SUPPORTED_VERSIONS.contains(v))
                .unwrap_or(PROTOCOL_VERSION);
            rpc_result(
                id,
                json!({
                    "protocolVersion": version,
                    "capabilities": {"tools": {"listChanged": false}},
                    "serverInfo": {"name": "workbench", "title": "Hermes Workbench", "version": env!("CARGO_PKG_VERSION")},
                    "instructions": "Workbench owns the user's tasks. Writes require the user's approval and may block until they decide.",
                }),
            )
        }
        "ping" => rpc_result(id, json!({})),
        "tools/list" => rpc_result(id, tools_list()),
        "tools/call" => {
            let Some(name) = params.get("name").and_then(Value::as_str) else {
                return Some(rpc_error(id, INVALID_PARAMS, "params.name is required"));
            };
            let args = params.get("arguments").cloned().unwrap_or(Value::Null);
            match tools::call(state, name, args).await {
                Ok(r) => rpc_result(id, format_tool_result(r)),
                Err(e) => rpc_error(id, INVALID_PARAMS, e.message),
            }
        }
        other => rpc_error(id, METHOD_NOT_FOUND, format!("method not found: {other}")),
    })
}

pub async fn post_mcp(State(state): State<SharedState>, body: axum::body::Bytes) -> Response {
    let msg: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(e) => {
            return Json(rpc_error(
                Value::Null,
                PARSE_ERROR,
                format!("parse error: {e}"),
            ))
            .into_response()
        }
    };
    if msg.is_array() {
        return Json(rpc_error(
            Value::Null,
            INVALID_REQUEST,
            "JSON-RPC batching is not supported by protocol 2025-06-18",
        ))
        .into_response();
    }
    let is_init = msg.get("method").and_then(Value::as_str) == Some("initialize");
    match handle_message(&state, msg).await {
        Some(resp) => {
            let mut r = Json(resp).into_response();
            if is_init {
                if let Ok(v) = axum::http::HeaderValue::from_str(&uuid::Uuid::new_v4().to_string())
                {
                    r.headers_mut().insert("mcp-session-id", v);
                }
            }
            r
        }
        None => StatusCode::ACCEPTED.into_response(),
    }
}

/// DELETE /mcp: session termination is a no-op (sessions are not tracked).
pub async fn delete_session() -> StatusCode {
    StatusCode::NO_CONTENT
}

/// GET/HEAD /mcp: this server offers no standalone SSE stream.
pub async fn method_not_allowed() -> Response {
    let mut r = StatusCode::METHOD_NOT_ALLOWED.into_response();
    r.headers_mut()
        .insert("allow", axum::http::HeaderValue::from_static("POST"));
    r
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_has_schemas() {
        let l = tools_list();
        let tools = l["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 4);
        for t in tools {
            assert_eq!(t["inputSchema"]["type"], "object");
            assert!(t["description"].as_str().unwrap().contains("tier"));
        }
    }

    #[test]
    fn result_formatting() {
        let ok = format_tool_result(ToolResult::Ok(json!({"a": 1})));
        assert_eq!(ok["content"][0]["type"], "text");
        assert_eq!(ok["structuredContent"]["a"], 1);
        assert!(ok.get("isError").is_none());
        let err = format_tool_result(ToolResult::Error("bad".into()));
        assert_eq!(err["isError"], true);
        assert_eq!(err["content"][0]["text"], "bad");
    }
}
