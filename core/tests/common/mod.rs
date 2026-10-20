#![allow(dead_code)]

use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::body::{Body, Bytes};
use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::Response;
use axum::routing::{get, post};
use axum::{Json, Router};
use futures::StreamExt;
use serde_json::{json, Value};
use workbench_core::{serve, Config, RunningServer};

pub struct Harness {
    pub server: RunningServer,
    pub base: String,
    pub token: String,
    pub client: reqwest::Client,
    pub dir: tempfile::TempDir,
}

pub fn config(dir: &std::path::Path, timeout_secs: u64, hermes_url: &str) -> Config {
    Config {
        addr: "127.0.0.1:0".parse().unwrap(),
        token: Some("test-token".into()),
        data_dir: dir.to_path_buf(),
        hermes_url: hermes_url.to_string(),
        hermes_api_key: Some("hermes-secret".into()),
        approval_timeout: Duration::from_secs(timeout_secs),
    }
}

impl Harness {
    pub async fn start() -> Harness {
        Self::start_with(30, "http://127.0.0.1:1/v1").await
    }

    pub async fn start_with(timeout_secs: u64, hermes_url: &str) -> Harness {
        let dir = tempfile::tempdir().unwrap();
        let server = serve(config(dir.path(), timeout_secs, hermes_url))
            .await
            .unwrap();
        Harness {
            base: format!("http://{}", server.addr),
            token: server.token.clone(),
            server,
            client: reqwest::Client::new(),
            dir,
        }
    }

    pub fn url(&self, path: &str) -> String {
        format!("{}{}", self.base, path)
    }

    pub fn req(&self, method: reqwest::Method, path: &str) -> reqwest::RequestBuilder {
        self.client
            .request(method, self.url(path))
            .bearer_auth(&self.token)
    }

    pub async fn get(&self, path: &str) -> Value {
        let r = self.req(reqwest::Method::GET, path).send().await.unwrap();
        assert!(r.status().is_success(), "GET {path} -> {}", r.status());
        r.json().await.unwrap()
    }

    pub async fn send_json(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Value,
    ) -> (u16, Value) {
        let r = self.req(method, path).json(&body).send().await.unwrap();
        let status = r.status().as_u16();
        let text = r.text().await.unwrap();
        (status, serde_json::from_str(&text).unwrap_or(Value::Null))
    }

    pub async fn post(&self, path: &str, body: Value) -> (u16, Value) {
        self.send_json(reqwest::Method::POST, path, body).await
    }

    pub async fn put(&self, path: &str, body: Value) -> (u16, Value) {
        self.send_json(reqwest::Method::PUT, path, body).await
    }

    /// Raw JSON-RPC POST to /mcp.
    pub async fn mcp_raw(&self, body: Value) -> reqwest::Response {
        self.req(reqwest::Method::POST, "/mcp")
            .json(&body)
            .send()
            .await
            .unwrap()
    }

    pub async fn mcp(&self, body: Value) -> Value {
        self.mcp_raw(body).await.json().await.unwrap()
    }

    /// tools/call; returns the JSON-RPC `result` (or panics on protocol error).
    pub async fn call_tool(&self, name: &str, args: Value) -> Value {
        let v = self
            .mcp(json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":name,"arguments":args}}))
            .await;
        assert!(v.get("error").is_none(), "protocol error: {v}");
        v["result"].clone()
    }

    pub async fn tasks(&self) -> Vec<Value> {
        self.get("/api/tasks").await.as_array().unwrap().clone()
    }

    /// Wait until a pending approval appears and return it.
    pub async fn wait_pending(&self) -> Value {
        for _ in 0..200 {
            let a = self.get("/api/approvals?status=pending").await;
            if let Some(first) = a.as_array().unwrap().first() {
                return first.clone();
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        panic!("no pending approval appeared");
    }

    pub async fn decide(&self, id: &str, decision: &str, note: Option<&str>) -> (u16, Value) {
        self.post(
            &format!("/api/approvals/{id}/decision"),
            json!({"decision": decision, "note": note}),
        )
        .await
    }

    /// Call a tier>=1 tool and approve it once it shows up.
    pub async fn call_and_approve(&self, name: &str, args: Value) -> Value {
        let (result, _) = tokio::join!(self.call_tool(name, args), async {
            let a = self.wait_pending().await;
            let (s, _) = self
                .decide(a["id"].as_str().unwrap(), "approve", None)
                .await;
            assert_eq!(s, 200);
        });
        result
    }

    pub async fn shutdown(self) {
        self.server.shutdown().await;
    }
}

/// Parse a complete SSE body into (event, data) pairs. Comments are skipped.
pub fn parse_sse(text: &str) -> Vec<(String, String)> {
    text.replace("\r\n", "\n")
        .split("\n\n")
        .filter_map(|block| {
            let mut event = String::from("message");
            let mut data = Vec::new();
            for line in block.lines() {
                if let Some(e) = line.strip_prefix("event:") {
                    event = e.trim().to_string();
                } else if let Some(d) = line.strip_prefix("data:") {
                    data.push(d.strip_prefix(' ').unwrap_or(d).to_string());
                }
            }
            if data.is_empty() {
                None
            } else {
                Some((event, data.join("\n")))
            }
        })
        .collect()
}

// ------------------------------------------------------------ fake hermes

#[derive(Default, Clone)]
pub struct Captured {
    pub requests: Vec<(Option<String>, Value, Option<String>)>,
}

#[derive(Clone)]
pub struct FakeState {
    pub captured: Arc<Mutex<Captured>>,
    pub model: String,
    pub fail_with: Option<u16>,
}

async fn fake_models() -> Json<Value> {
    Json(json!({"object": "list", "data": [{"id": "hermes-agent"}]}))
}

async fn fake_chat(
    State(st): State<FakeState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    st.captured.lock().unwrap().requests.push((
        headers
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .map(String::from),
        body,
        headers
            .get("x-hermes-session-id")
            .and_then(|v| v.to_str().ok())
            .map(String::from),
    ));
    if let Some(code) = st.fail_with {
        return Response::builder()
            .status(code)
            .body(Body::from(
                "{\"error\":{\"message\":\"upstream exploded\"}}",
            ))
            .unwrap();
    }
    let m = &st.model;
    let mut text = String::new();
    text.push_str(&format!(
        "data: {}\n\n",
        json!({"model": m, "choices":[{"delta":{"role":"assistant"}}]})
    ));
    text.push_str(": keepalive\n\n");
    text.push_str("event: hermes.other\ndata: {\"x\":1}\n\n");
    text.push_str(&format!(
        "event: hermes.tool.progress\ndata: {}\n\n",
        json!({"tool": "mcp__workbench__tasks_create", "toolCallId": "c1", "status": "running"})
    ));
    for piece in ["Hel", "lo ", "wörld"] {
        text.push_str(&format!(
            "data: {}\n\n",
            json!({"model": m, "choices":[{"delta":{"content":piece}}]})
        ));
    }
    text.push_str(&format!(
        "data: {}\n\n",
        json!({"model": m, "choices":[],"usage":{"prompt_tokens":1000,"completion_tokens":2000}})
    ));
    text.push_str("data: [DONE]\n\n");
    // Deliberately awkward chunk boundaries (splits lines and UTF-8 sequences).
    let bytes = text.into_bytes();
    let chunks: Vec<Bytes> = bytes.chunks(23).map(Bytes::copy_from_slice).collect();
    let stream = futures::stream::iter(chunks).then(|c| async move {
        tokio::time::sleep(Duration::from_millis(3)).await;
        Ok::<_, std::convert::Infallible>(c)
    });
    Response::builder()
        .header("content-type", "text/event-stream")
        .body(Body::from_stream(stream))
        .unwrap()
}

pub struct FakeHermes {
    pub url: String,
    pub captured: Arc<Mutex<Captured>>,
    _handle: tokio::task::JoinHandle<()>,
}

/// A tiny OpenAI-compatible server on a random port.
pub async fn fake_hermes(model: &str, fail_with: Option<u16>) -> FakeHermes {
    let captured = Arc::new(Mutex::new(Captured::default()));
    let st = FakeState {
        captured: captured.clone(),
        model: model.to_string(),
        fail_with,
    };
    let app = Router::new()
        .route("/v1/models", get(fake_models))
        .route("/v1/chat/completions", post(fake_chat))
        .with_state(st);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let handle = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    FakeHermes {
        url: format!("http://{addr}/v1"),
        captured,
        _handle: handle,
    }
}
