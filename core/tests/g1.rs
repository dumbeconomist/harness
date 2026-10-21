//! G1 core: connection doctor, chat threads, latest-undoable, ledger windows.

mod common;

use std::sync::{Arc, Mutex};

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use common::*;
use reqwest::Method;
use serde_json::{json, Value};
use workbench_core::serve;

// ------------------------------------------------------- configurable fake

#[derive(Clone)]
struct Cfg {
    /// Key `/models` and `/toolsets` require (None = open).
    require_key: Option<&'static str>,
    toolsets: Option<Value>,
    chat_status: u16,
    models_status: u16,
    seen_toolsets_auth: Arc<Mutex<Vec<Option<String>>>>,
}

impl Cfg {
    fn new() -> Cfg {
        Cfg {
            require_key: None,
            toolsets: Some(json!([{"name": "web", "enabled": false}])),
            chat_status: 200,
            models_status: 200,
            seen_toolsets_auth: Default::default(),
        }
    }
}

fn authed(cfg: &Cfg, h: &HeaderMap) -> bool {
    match cfg.require_key {
        None => true,
        Some(k) => {
            h.get("authorization").and_then(|v| v.to_str().ok()) == Some(&format!("Bearer {k}"))
        }
    }
}

async fn f_models(State(cfg): State<Cfg>, h: HeaderMap) -> Response {
    if !authed(&cfg, &h) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    if cfg.models_status != 200 {
        return StatusCode::from_u16(cfg.models_status)
            .unwrap()
            .into_response();
    }
    Json(json!({"data": [{"id": "hermes-agent"}]})).into_response()
}

async fn f_toolsets(State(cfg): State<Cfg>, h: HeaderMap) -> Response {
    cfg.seen_toolsets_auth.lock().unwrap().push(
        h.get("authorization")
            .and_then(|v| v.to_str().ok())
            .map(String::from),
    );
    if !authed(&cfg, &h) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    match &cfg.toolsets {
        Some(v) => Json(v.clone()).into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn f_chat(State(cfg): State<Cfg>, Json(_b): Json<Value>) -> Response {
    if cfg.chat_status != 200 {
        return (
            StatusCode::from_u16(cfg.chat_status).unwrap(),
            Json(json!({"error": {"message": "model not found: hermes-agent"}})),
        )
            .into_response();
    }
    Json(json!({"choices": [{"message": {"content": "p"}}]})).into_response()
}

/// Returns the base URL ending in /v1.
async fn spawn_fake(cfg: Cfg) -> String {
    let app = Router::new()
        .route("/v1/models", get(f_models))
        .route("/v1/toolsets", get(f_toolsets))
        .route("/v1/chat/completions", post(f_chat))
        .with_state(cfg);
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(l, app).await.unwrap();
    });
    format!("http://{addr}/v1")
}

async fn doctor(h: &Harness, deep: bool) -> Value {
    h.get(if deep {
        "/api/doctor?deep=1"
    } else {
        "/api/doctor"
    })
    .await
}

fn check<'a>(d: &'a Value, id: &str) -> &'a Value {
    d["checks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["id"] == id)
        .unwrap_or_else(|| panic!("no check {id} in {d}"))
}

fn statuses(d: &Value) -> Vec<(String, String)> {
    d["checks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| {
            (
                c["id"].as_str().unwrap().to_string(),
                c["status"].as_str().unwrap().to_string(),
            )
        })
        .collect()
}

async fn mcp_initialize(h: &Harness) {
    let v = h
        .mcp(
            json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{
            "protocolVersion":"2025-06-18","capabilities":{},
            "clientInfo":{"name":"hermes-agent","version":"9.9"}}}),
        )
        .await;
    assert!(v.get("error").is_none());
}

// ------------------------------------------------------------------ doctor

#[tokio::test]
async fn doctor_requires_auth() {
    let h = Harness::start().await;
    let r = h.client.get(h.url("/api/doctor")).send().await.unwrap();
    assert_eq!(r.status(), 401);
    h.shutdown().await;
}

#[tokio::test]
async fn doctor_hermes_down_fails_and_skips_the_rest() {
    let h = Harness::start().await; // 127.0.0.1:1 is closed
    let d = doctor(&h, false).await;
    assert_eq!(d["ok"], false);
    let r = check(&d, "hermes_reachable");
    assert_eq!(r["status"], "fail");
    assert_eq!(r["blocking"], true);
    assert!(r["fix"]
        .as_str()
        .unwrap()
        .contains("hermes -p workbench gateway run"));
    assert_eq!(
        statuses(&d)
            .iter()
            .map(|s| s.1.as_str())
            .collect::<Vec<_>>(),
        ["fail", "skip", "skip", "skip", "skip", "skip"]
    );
    h.shutdown().await;
}

#[tokio::test]
async fn doctor_401_is_an_auth_failure_without_leaking_the_key() {
    let mut cfg = Cfg::new();
    cfg.require_key = Some("a-different-key");
    let url = spawn_fake(cfg).await;
    let h = Harness::start_with(30, &url).await; // harness key is "hermes-secret"
    let d = doctor(&h, true).await;
    assert_eq!(d["ok"], false);
    assert_eq!(check(&d, "hermes_reachable")["status"], "ok");
    let a = check(&d, "hermes_auth");
    assert_eq!(a["status"], "fail");
    assert!(a["fix"].as_str().unwrap().contains("API_SERVER_KEY"));
    assert_eq!(check(&d, "hermes_model")["status"], "skip");
    assert_eq!(check(&d, "profile_locked")["status"], "skip");
    let raw = d.to_string();
    for secret in [
        "hermes-secret",
        "a-different-key",
        "test-token",
        "test-mcp-token",
    ] {
        assert!(!raw.contains(secret), "leaked {secret}");
    }
    h.shutdown().await;
}

#[tokio::test]
async fn doctor_ok_without_mcp_connect_warns() {
    let url = spawn_fake(Cfg::new()).await;
    let h = Harness::start_with(30, &url).await;
    let d = doctor(&h, false).await;
    assert_eq!(d["ok"], true, "warnings do not fail the doctor: {d}");
    assert_eq!(check(&d, "hermes_reachable")["status"], "ok");
    assert_eq!(check(&d, "hermes_auth")["status"], "ok");
    assert_eq!(check(&d, "hermes_model")["status"], "skip"); // not deep
    let m = check(&d, "mcp_connected");
    assert_eq!(m["status"], "warn");
    assert_eq!(m["blocking"], false);
    assert!(m["fix"].as_str().unwrap().contains("WORKBENCH_MCP_TOKEN"));
    let t = check(&d, "mcp_tools_seen");
    assert_eq!(t["status"], "skip");
    assert_eq!(t["message"], "Waiting for Hermes to connect");
    assert_eq!(check(&d, "profile_locked")["status"], "ok");
    h.shutdown().await;
}

#[tokio::test]
async fn doctor_tracks_initialize_then_tools_list_then_call() {
    let url = spawn_fake(Cfg::new()).await;
    let h = Harness::start_with(30, &url).await;

    mcp_initialize(&h).await;
    let d = doctor(&h, false).await;
    let c = check(&d, "mcp_connected");
    assert_eq!(c["status"], "ok");
    assert!(c["message"].as_str().unwrap().contains("hermes-agent"));
    assert_eq!(check(&d, "mcp_tools_seen")["status"], "warn");
    assert!(check(&d, "mcp_tools_seen")["fix"]
        .as_str()
        .unwrap()
        .contains("mcp_servers.workbench"));

    h.mcp(json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}))
        .await;
    let d = doctor(&h, false).await;
    assert_eq!(check(&d, "mcp_tools_seen")["status"], "ok");
    assert_eq!(d["ok"], true);
    assert!(statuses(&d).iter().all(|(_, s)| s == "ok" || s == "skip"));

    // a tools/call is recorded too (read-only tool, no approval)
    h.call_tool("tasks_list", json!({})).await;
    let snap: Value = {
        let c = rusqlite::Connection::open(h.dir.path().join("workbench.db")).unwrap();
        let raw: String = c
            .query_row(
                "SELECT value_json FROM settings WHERE key='doctor'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        serde_json::from_str(&raw).unwrap()
    };
    assert!(snap["mcp_last_tool_call_at"].is_string());
    assert_eq!(snap["mcp_client_info"]["name"], "hermes-agent");
    assert_eq!(snap["mcp_client_info"]["version"], "9.9");
    h.shutdown().await;
}

#[tokio::test]
async fn doctor_mcp_seen_survives_a_restart() {
    let url = spawn_fake(Cfg::new()).await;
    let h = Harness::start_with(30, &url).await;
    mcp_initialize(&h).await;
    h.mcp(json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}))
        .await;
    let dir = h.dir.path().to_path_buf();
    h.server.shutdown().await;

    let server = serve(config(&dir, 30, &url)).await.unwrap();
    let h2 = Harness {
        base: format!("http://{}", server.addr),
        token: server.token.clone(),
        mcp_token: server.mcp_token.clone(),
        server,
        client: reqwest::Client::new(),
        dir: tempfile::tempdir().unwrap(), // unused: the real data dir is `dir`
    };
    let d = doctor(&h2, false).await;
    assert_eq!(check(&d, "mcp_connected")["status"], "ok");
    assert_eq!(check(&d, "mcp_tools_seen")["status"], "ok");
    h2.shutdown().await;
}

#[tokio::test]
async fn doctor_unlocked_profile_fails_in_both_shapes() {
    for toolsets in [
        json!([{"name": "web", "enabled": false}, {"name": "terminal", "enabled": true}]),
        json!({"file": {"enabled": true}, "terminal": {"enabled": false}}),
        json!({"toolsets": [{"name": "terminal", "enabled": true}]}),
    ] {
        let mut cfg = Cfg::new();
        cfg.toolsets = Some(toolsets.clone());
        let url = spawn_fake(cfg).await;
        let h = Harness::start_with(30, &url).await;
        let d = doctor(&h, false).await;
        let p = check(&d, "profile_locked");
        assert_eq!(p["status"], "fail", "{toolsets}");
        assert_eq!(p["blocking"], true);
        assert!(p["fix"].as_str().unwrap().contains("locked profile"));
        assert_eq!(d["ok"], false, "{toolsets}");
        h.shutdown().await;
    }
}

#[tokio::test]
async fn doctor_locked_profile_with_terminal_disabled_is_ok() {
    let mut cfg = Cfg::new();
    cfg.toolsets = Some(json!({"terminal": {"enabled": false}, "file": {"enabled": false}}));
    let seen = cfg.seen_toolsets_auth.clone();
    let url = spawn_fake(cfg).await;
    let h = Harness::start_with(30, &url).await;
    let d = doctor(&h, false).await;
    assert_eq!(check(&d, "profile_locked")["status"], "ok");
    assert_eq!(
        seen.lock().unwrap().as_slice(),
        [Some("Bearer hermes-secret".to_string())]
    );
    h.shutdown().await;
}

#[tokio::test]
async fn doctor_toolsets_404_warns_cannot_verify() {
    let mut cfg = Cfg::new();
    cfg.toolsets = None;
    let url = spawn_fake(cfg).await;
    let h = Harness::start_with(30, &url).await;
    let d = doctor(&h, false).await;
    let p = check(&d, "profile_locked");
    assert_eq!(p["status"], "warn");
    assert!(p["message"].as_str().unwrap().contains("can't verify"));
    assert_eq!(d["ok"], true);
    h.shutdown().await;
}

#[tokio::test]
async fn doctor_deep_model_check() {
    // passing
    let url = spawn_fake(Cfg::new()).await;
    let h = Harness::start_with(30, &url).await;
    // before any deep run, a plain poll reports the model as not tested
    let d = doctor(&h, false).await;
    assert_eq!(check(&d, "hermes_model")["status"], "skip");
    assert!(check(&d, "hermes_model")["checked_at"].is_null());
    let d = doctor(&h, true).await;
    assert_eq!(check(&d, "hermes_model")["status"], "ok");
    assert!(check(&d, "hermes_model")["checked_at"].is_string());
    assert_eq!(d["ok"], true);
    let d = doctor(&h, false).await;
    let m = check(&d, "hermes_model");
    assert_eq!(m["status"], "ok");
    assert!(
        m["checked_at"].is_string(),
        "cached deep result is included"
    );
    h.shutdown().await;

    // failing: the upstream error is surfaced and later checks are skipped
    let mut cfg = Cfg::new();
    cfg.chat_status = 404;
    let url = spawn_fake(cfg).await;
    let h = Harness::start_with(30, &url).await;
    let d = doctor(&h, true).await;
    let m = check(&d, "hermes_model");
    assert_eq!(m["status"], "fail");
    assert!(m["message"]
        .as_str()
        .unwrap()
        .contains("model not found: hermes-agent"));
    assert_eq!(d["ok"], false);
    assert_eq!(check(&d, "mcp_connected")["status"], "skip");
    assert_eq!(check(&d, "profile_locked")["status"], "skip");
    // the failure does not vanish on the next plain poll: it is replayed with checked_at
    let d = doctor(&h, false).await;
    let m = check(&d, "hermes_model");
    assert_eq!(m["status"], "fail");
    assert!(m["checked_at"].is_string());
    assert!(m["message"].as_str().unwrap().contains("model not found"));
    assert_eq!(d["ok"], false);
    assert_eq!(check(&d, "profile_locked")["status"], "skip");
    h.shutdown().await;
}

#[tokio::test]
async fn doctor_records_brain_state_from_chat() {
    let fake = fake_hermes("hermes-agent", None).await;
    let h = Harness::start_with(30, &fake.url).await;
    h.req(Method::POST, "/api/chat")
        .json(&json!({"messages":[{"role":"user","content":"hi"}]}))
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    let ok_at = brain_state(&h, "brain_last_ok_at");
    assert!(ok_at.is_string());
    h.shutdown().await;

    let fake = fake_hermes("hermes-agent", Some(401)).await;
    let h = Harness::start_with(30, &fake.url).await;
    h.req(Method::POST, "/api/chat")
        .json(&json!({"messages":[{"role":"user","content":"hi"}]}))
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    let err = brain_state(&h, "brain_last_error");
    assert_eq!(err["status"], 401);
    assert!(err["at"].is_string());
    assert!(!err.to_string().contains("hermes-secret"));
    h.shutdown().await;
}

fn brain_state(h: &Harness, key: &str) -> Value {
    let c = rusqlite::Connection::open(h.dir.path().join("workbench.db")).unwrap();
    let raw: String = c
        .query_row(
            "SELECT value_json FROM settings WHERE key='doctor'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    serde_json::from_str::<Value>(&raw).unwrap()[key].clone()
}

// ----------------------------------------------------------------- threads

async fn chat_in_thread(h: &Harness, thread: &str, text: &str) -> Vec<(String, String)> {
    let body = h
        .req(Method::POST, "/api/chat")
        .json(&json!({"thread_id": thread, "messages":[{"role":"user","content":text}]}))
        .send()
        .await
        .unwrap();
    assert_eq!(body.status(), 200);
    parse_sse(&body.text().await.unwrap())
}

#[tokio::test]
async fn thread_crud_and_filters() {
    let h = Harness::start().await;
    let (s, a) = h
        .post(
            "/api/threads",
            json!({"context_kind":"task","context_id":"t1","title":"Plan"}),
        )
        .await;
    assert_eq!(s, 200);
    assert_eq!(a["title"], "Plan");
    assert_eq!(a["context_kind"], "task");
    let (_, b) = h.post("/api/threads", json!({})).await;
    assert_eq!(b["title"], "New thread");
    assert!(b["context_kind"].is_null());
    let (_, c) = h
        .post(
            "/api/threads",
            json!({"context_kind":"task","context_id":"t1"}),
        )
        .await;

    let all = h.get("/api/threads").await;
    let ids: Vec<_> = all
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["id"].clone())
        .collect();
    assert_eq!(ids, [c["id"].clone(), b["id"].clone(), a["id"].clone()]);
    let t1 = h.get("/api/threads?context_kind=task&context_id=t1").await;
    assert_eq!(t1.as_array().unwrap().len(), 2);
    assert_eq!(t1[0]["id"], c["id"]);
    let none = h.get("/api/threads?context_kind=task&context_id=zzz").await;
    assert!(none.as_array().unwrap().is_empty());

    let aid = a["id"].as_str().unwrap();
    assert!(h
        .get(&format!("/api/threads/{aid}/messages"))
        .await
        .as_array()
        .unwrap()
        .is_empty());
    let r = h
        .req(Method::DELETE, &format!("/api/threads/{aid}"))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 204);
    let r = h
        .req(Method::DELETE, &format!("/api/threads/{aid}"))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 404);
    let r = h
        .req(Method::GET, &format!("/api/threads/{aid}/messages"))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 404);
    assert_eq!(h.get("/api/threads").await.as_array().unwrap().len(), 2);
    h.shutdown().await;
}

#[tokio::test]
async fn chat_with_thread_persists_messages_and_sends_session_header() {
    let fake = fake_hermes("hermes-agent", None).await;
    let h = Harness::start_with(30, &fake.url).await;
    let (_, t) = h.post("/api/threads", json!({})).await;
    let tid = t["id"].as_str().unwrap();

    let evs = chat_in_thread(&h, tid, "hello thread").await;
    assert_eq!(evs.last().unwrap().0, "done");

    let msgs = h.get(&format!("/api/threads/{tid}/messages")).await;
    let msgs = msgs.as_array().unwrap();
    // user, tool chip, assistant
    let roles: Vec<_> = msgs.iter().map(|m| m["role"].as_str().unwrap()).collect();
    assert_eq!(roles, ["user", "tool", "assistant"]);
    assert_eq!(msgs[0]["content"], "hello thread");
    assert_eq!(msgs[1]["tool_json"]["tool"], "mcp__workbench__tasks_create");
    assert_eq!(msgs[1]["tool_json"]["status"], "running");
    assert_eq!(msgs[2]["content"], "Hello wörld");
    assert!(msgs[0]["tool_json"].is_null());

    let cap = fake.captured.lock().unwrap().requests.clone();
    assert_eq!(
        cap[0].2.as_deref(),
        Some(format!("wb-{tid}").as_str()),
        "X-Hermes-Session-Id is wb-<thread id>"
    );

    // first message titles the thread
    let threads = h.get("/api/threads").await;
    assert_eq!(threads[0]["title"], "hello thread");
    h.shutdown().await;
}

#[tokio::test]
async fn thread_history_replays_in_order_and_ignores_body_history() {
    let fake = fake_hermes("hermes-agent", None).await;
    let h = Harness::start_with(30, &fake.url).await;
    let (_, t) = h.post("/api/threads", json!({})).await;
    let tid = t["id"].as_str().unwrap();
    chat_in_thread(&h, tid, "first").await;

    // The body claims a different history; only its last user message counts.
    let r = h
        .req(Method::POST, "/api/chat")
        .json(&json!({"thread_id": tid, "messages":[
            {"role":"user","content":"BOGUS"},
            {"role":"assistant","content":"BOGUS"},
            {"role":"user","content":"second"}]}))
        .send()
        .await
        .unwrap();
    r.text().await.unwrap();

    let cap = fake.captured.lock().unwrap().requests.clone();
    assert_eq!(cap.len(), 2);
    let sent: Vec<(String, String)> = cap[1].1["messages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| {
            (
                m["role"].as_str().unwrap().to_string(),
                m["content"].as_str().unwrap().to_string(),
            )
        })
        .collect();
    assert_eq!(
        sent,
        [
            ("user".to_string(), "first".to_string()),
            ("assistant".to_string(), "Hello wörld".to_string()),
            ("user".to_string(), "second".to_string()),
        ],
        "tool rows are not replayed"
    );
    assert_eq!(cap[1].2.as_deref(), Some(format!("wb-{tid}").as_str()));
    let n = h.get(&format!("/api/threads/{tid}/messages")).await;
    assert_eq!(n.as_array().unwrap().len(), 6);
    h.shutdown().await;
}

#[tokio::test]
async fn thread_chat_errors_and_no_thread_behaviour() {
    let fake = fake_hermes("hermes-agent", None).await;
    let h = Harness::start_with(30, &fake.url).await;
    let (s, v) = h
        .post(
            "/api/chat",
            json!({"thread_id":"nope","messages":[{"role":"user","content":"x"}]}),
        )
        .await;
    assert_eq!(s, 404);
    assert_eq!(v["error"]["code"], "not_found");
    let (_, t) = h.post("/api/threads", json!({})).await;
    let (s, _) = h
        .post(
            "/api/chat",
            json!({"thread_id": t["id"], "messages":[{"role":"assistant","content":"x"}]}),
        )
        .await;
    assert_eq!(s, 400);

    // old callers: no thread_id, session_id passes through, nothing persisted
    h.req(Method::POST, "/api/chat")
        .json(&json!({"messages":[{"role":"user","content":"hi"}],"session_id":"legacy"}))
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    let cap = fake.captured.lock().unwrap().requests.clone();
    assert_eq!(cap.last().unwrap().2.as_deref(), Some("legacy"));
    let tid = t["id"].as_str().unwrap();
    assert!(h
        .get(&format!("/api/threads/{tid}/messages"))
        .await
        .as_array()
        .unwrap()
        .is_empty());
    h.shutdown().await;
}

#[tokio::test]
async fn failed_stream_keeps_user_message_only() {
    let fake = fake_hermes("hermes-agent", Some(500)).await;
    let h = Harness::start_with(30, &fake.url).await;
    let (_, t) = h.post("/api/threads", json!({})).await;
    let tid = t["id"].as_str().unwrap();
    let evs = chat_in_thread(&h, tid, "will fail").await;
    assert_eq!(evs.last().unwrap().0, "error");
    let msgs = h.get(&format!("/api/threads/{tid}/messages")).await;
    assert_eq!(msgs.as_array().unwrap().len(), 1);
    assert_eq!(msgs[0]["role"], "user");
    h.shutdown().await;
}

#[tokio::test]
async fn deleting_a_thread_removes_its_messages() {
    let fake = fake_hermes("hermes-agent", None).await;
    let h = Harness::start_with(30, &fake.url).await;
    let (_, t) = h.post("/api/threads", json!({})).await;
    let tid = t["id"].as_str().unwrap();
    chat_in_thread(&h, tid, "hi").await;
    let r = h
        .req(Method::DELETE, &format!("/api/threads/{tid}"))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 204);
    let c = rusqlite::Connection::open(h.dir.path().join("workbench.db")).unwrap();
    let n: i64 = c
        .query_row("SELECT count(*) FROM messages", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 0);
    h.shutdown().await;
}

// -------------------------------------------------------- latest-undoable

#[tokio::test]
async fn latest_undoable_follows_the_journal() {
    let h = Harness::start().await;
    assert!(h.get("/api/journal/latest-undoable").await.is_null());

    let (_, a) = h.post("/api/tasks", json!({"title":"A"})).await;
    let (_, b) = h.post("/api/tasks", json!({"title":"B"})).await;
    let latest = h.get("/api/journal/latest-undoable").await;
    assert_eq!(latest["tool"], "tasks_create");
    assert_eq!(latest["result_json"]["task"]["id"], b["id"]);

    // Editing B makes the update the newest undoable entry; the create of B is stale.
    h.req(
        Method::PATCH,
        &format!("/api/tasks/{}", b["id"].as_str().unwrap()),
    )
    .json(&json!({"status":"doing"}))
    .send()
    .await
    .unwrap();
    let latest = h.get("/api/journal/latest-undoable").await;
    assert_eq!(latest["tool"], "tasks_update");

    // Undo it -> the undo entry itself is never offered; B's create is current again.
    let id = latest["id"].as_str().unwrap();
    let (s, _) = h.post(&format!("/api/journal/{id}/undo"), json!({})).await;
    assert_eq!(s, 200);
    let latest = h.get("/api/journal/latest-undoable").await;
    assert_eq!(latest["tool"], "tasks_create");
    assert_eq!(latest["result_json"]["task"]["id"], b["id"]);

    // Delete B: its create is no longer applicable, the delete is the newest undoable.
    let bid = b["id"].as_str().unwrap();
    h.req(Method::DELETE, &format!("/api/tasks/{bid}"))
        .send()
        .await
        .unwrap();
    let latest = h.get("/api/journal/latest-undoable").await;
    assert_eq!(latest["tool"], "tasks_delete");
    let id = latest["id"].as_str().unwrap();
    h.post(&format!("/api/journal/{id}/undo"), json!({})).await;
    let latest = h.get("/api/journal/latest-undoable").await;
    assert_eq!(latest["tool"], "tasks_create");
    assert_eq!(latest["result_json"]["task"]["id"], b["id"]);
    let _ = a;
    h.shutdown().await;
}

#[tokio::test]
async fn latest_undoable_skips_entries_blocked_as_stale() {
    let h = Harness::start().await;
    let (_, a) = h.post("/api/tasks", json!({"title":"A"})).await;
    let aid = a["id"].as_str().unwrap();
    let (_, b) = h.post("/api/tasks", json!({"title":"B"})).await;
    // Editing A makes A's create stale; the update is the newest undoable entry.
    h.req(Method::PATCH, &format!("/api/tasks/{aid}"))
        .json(&json!({"title":"A2"}))
        .send()
        .await
        .unwrap();
    // Edit B too, then undo that edit: the newest undoable entry is the A edit.
    let l = h.get("/api/journal/latest-undoable").await;
    assert_eq!(l["tool"], "tasks_update");
    h.req(
        Method::PATCH,
        &format!("/api/tasks/{}", b["id"].as_str().unwrap()),
    )
    .json(&json!({"title":"B2"}))
    .send()
    .await
    .unwrap();
    let l = h.get("/api/journal/latest-undoable").await;
    assert_eq!(l["args_json"]["title"], "B2");
    let id = l["id"].as_str().unwrap();
    h.post(&format!("/api/journal/{id}/undo"), json!({})).await;
    let l = h.get("/api/journal/latest-undoable").await;
    assert_eq!(l["args_json"]["title"], "A2");
    h.shutdown().await;
}

// ------------------------------------------------------------------ ledger

#[tokio::test]
async fn ledger_summary_zero_fills_exactly_fourteen_utc_days() {
    let h = Harness::start().await;
    let s = h.get("/api/ledger/summary").await;
    let days = s["by_day"].as_array().unwrap();
    assert_eq!(days.len(), 14);
    assert!(days.iter().all(|d| d["usd"] == 0.0));
    assert_eq!(s["today_usd"], 0.0);
    assert_eq!(s["last7_usd"], 0.0);
    assert_eq!(s["last30_usd"], 0.0);
    let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
    assert_eq!(days[13]["day"], today.as_str());
    let names: Vec<_> = days.iter().map(|d| d["day"].as_str().unwrap()).collect();
    let mut sorted = names.clone();
    sorted.sort();
    assert_eq!(names, sorted, "ascending");
    sorted.dedup();
    assert_eq!(sorted.len(), 14, "no duplicates / gaps");

    // Seed: today, 3 days ago, 10 days ago, 20 days ago, 40 days ago.
    let c = rusqlite::Connection::open(h.dir.path().join("workbench.db")).unwrap();
    for (i, back) in [0i64, 3, 10, 20, 40].into_iter().enumerate() {
        let ts = (chrono::Utc::now() - chrono::Duration::days(back))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        c.execute(
            "INSERT INTO ledger(id, ts, run_id, model, prompt_tokens, completion_tokens, cost_usd, source)
             VALUES (?1, ?2, ?1, 'm', 1, 1, ?3, 'chat')",
            rusqlite::params![format!("r{i}"), ts, 1.0f64],
        )
        .unwrap();
    }
    let s = h.get("/api/ledger/summary").await;
    let days = s["by_day"].as_array().unwrap();
    assert_eq!(days.len(), 14);
    let nonzero: Vec<usize> = (0..14)
        .filter(|i| days[*i]["usd"].as_f64().unwrap() > 0.0)
        .collect();
    assert_eq!(nonzero, [3, 10, 13]); // 10, 3 and 0 days ago
    assert_eq!(s["today_usd"], 1.0);
    assert_eq!(s["last7_usd"], 2.0);
    assert_eq!(s["last30_usd"], 4.0);
    assert_eq!(s["total_usd"], 5.0);
    h.shutdown().await;
}

// ------------------------------------------------- round 2: new behaviours

#[tokio::test]
async fn doctor_models_5xx_warns_reachable() {
    let mut cfg = Cfg::new();
    cfg.models_status = 503;
    let url = spawn_fake(cfg).await;
    let h = Harness::start_with(30, &url).await;
    let d = doctor(&h, false).await;
    let r = check(&d, "hermes_reachable");
    assert_eq!(r["status"], "warn");
    assert_eq!(r["message"], "Hermes answered with an error (HTTP 503)");
    assert_eq!(d["ok"], true);
    h.shutdown().await;
}

// A fake that can fail, echo the caller's secrets back, and stream slowly.
#[derive(Clone)]
struct TFake {
    fail: Arc<std::sync::atomic::AtomicBool>,
    delay_ms: u64,
    bodies: Arc<Mutex<Vec<Value>>>,
}

async fn t_chat(State(f): State<TFake>, Json(body): Json<Value>) -> Response {
    use std::sync::atomic::Ordering;
    f.bodies.lock().unwrap().push(body.clone());
    if f.fail.load(Ordering::SeqCst) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({"error": {"message":
                "bad credentials: Bearer hermes-secret / ui test-token / mcp test-mcp-token"}})),
        )
            .into_response();
    }
    if body["stream"] != true {
        return Json(json!({"choices": [{"message": {"content": "p"}}]})).into_response();
    }
    let delay = f.delay_ms;
    let mut chunks: Vec<String> = ["A", "B", "C", "D"]
        .iter()
        .map(|t| {
            format!(
                "data: {}\n\n",
                json!({"model": "hermes-agent", "choices":[{"delta":{"content": t}}]})
            )
        })
        .collect();
    chunks.push(format!(
        "data: {}\n\n",
        json!({"model":"hermes-agent","choices":[],"usage":{"prompt_tokens":5,"completion_tokens":7}})
    ));
    chunks.push("data: [DONE]\n\n".into());
    let stream = futures::stream::iter(chunks).then(move |c| async move {
        tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
        Ok::<_, std::convert::Infallible>(axum::body::Bytes::from(c))
    });
    Response::builder()
        .header("content-type", "text/event-stream")
        .body(axum::body::Body::from_stream(stream))
        .unwrap()
}

use futures::StreamExt;

async fn spawn_tfake(fail: bool, delay_ms: u64) -> (String, TFake) {
    let f = TFake {
        fail: Arc::new(std::sync::atomic::AtomicBool::new(fail)),
        delay_ms,
        bodies: Default::default(),
    };
    let app = Router::new()
        .route("/v1/models", get(f_models_open))
        .route("/v1/chat/completions", post(t_chat))
        .with_state(f.clone());
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(l, app).await.unwrap();
    });
    (format!("http://{addr}/v1"), f)
}

async fn f_models_open() -> Json<Value> {
    Json(json!({"data": []}))
}

fn db_doctor_json(h: &Harness) -> String {
    let c = rusqlite::Connection::open(h.dir.path().join("workbench.db")).unwrap();
    c.query_row(
        "SELECT value_json FROM settings WHERE key='doctor'",
        [],
        |r| r.get(0),
    )
    .unwrap()
}

const SECRETS: [&str; 3] = ["hermes-secret", "test-token", "test-mcp-token"];

#[tokio::test]
async fn echoed_secrets_never_reach_storage_doctor_or_sse() {
    let (url, _f) = spawn_tfake(true, 0).await;
    let h = Harness::start_with(30, &url).await;

    // deep doctor path
    let d = doctor(&h, true).await;
    let m = check(&d, "hermes_model");
    assert_eq!(m["status"], "fail");
    assert!(m["message"].as_str().unwrap().contains("bad credentials"));
    let raw = d.to_string();
    for s in SECRETS {
        assert!(!raw.contains(s), "doctor response leaked {s}: {raw}");
    }
    let stored = db_doctor_json(&h);
    assert!(stored.contains("bad credentials"));
    for s in SECRETS {
        assert!(!stored.contains(s), "settings.doctor leaked {s}: {stored}");
    }

    // chat SSE path
    let text = h
        .req(Method::POST, "/api/chat")
        .json(&json!({"messages":[{"role":"user","content":"hi"}]}))
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert!(text.contains("event: error"), "{text}");
    assert!(text.contains("bad credentials"));
    for s in SECRETS {
        assert!(!text.contains(s), "SSE error leaked {s}: {text}");
    }
    let stored = db_doctor_json(&h);
    for s in SECRETS {
        assert!(!stored.contains(s), "settings.doctor leaked {s} after chat");
    }
    h.shutdown().await;
}

#[tokio::test]
async fn failed_turns_are_marked_and_not_replayed() {
    let (url, f) = spawn_tfake(true, 0).await;
    let h = Harness::start_with(30, &url).await;
    let (_, t) = h.post("/api/threads", json!({})).await;
    let tid = t["id"].as_str().unwrap();
    let evs = chat_in_thread(&h, tid, "this one fails").await;
    assert_eq!(evs.last().unwrap().0, "error");
    let msgs = h.get(&format!("/api/threads/{tid}/messages")).await;
    assert_eq!(msgs.as_array().unwrap().len(), 1);
    assert_eq!(msgs[0]["status"], "failed");

    f.fail.store(false, std::sync::atomic::Ordering::SeqCst);
    let evs = chat_in_thread(&h, tid, "this one works").await;
    assert_eq!(evs.last().unwrap().0, "done");
    let sent = f.bodies.lock().unwrap().last().unwrap()["messages"].clone();
    let sent: Vec<_> = sent
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["content"].as_str().unwrap())
        .collect();
    assert_eq!(sent, ["this one works"], "failed turn excluded from replay");
    let msgs = h.get(&format!("/api/threads/{tid}/messages")).await;
    let st: Vec<_> = msgs
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["status"].as_str().unwrap())
        .collect();
    assert_eq!(st, ["failed", "ok", "ok"]);
    h.shutdown().await;
}

#[tokio::test]
async fn client_drop_keeps_partial_reply_and_ledger() {
    let (url, _f) = spawn_tfake(false, 120).await;
    let h = Harness::start_with(30, &url).await;
    let (_, t) = h.post("/api/threads", json!({})).await;
    let tid = t["id"].as_str().unwrap();
    let mut resp = h
        .req(Method::POST, "/api/chat")
        .json(&json!({"thread_id": tid, "messages":[{"role":"user","content":"go"}]}))
        .send()
        .await
        .unwrap();
    let mut seen = String::new();
    while !seen.contains("event: delta") {
        let c = resp.chunk().await.unwrap().expect("stream ended early");
        seen.push_str(&String::from_utf8_lossy(&c));
    }
    drop(resp); // the user pressed stop / closed the window

    let mut found = None;
    for _ in 0..100 {
        let msgs = h.get(&format!("/api/threads/{tid}/messages")).await;
        if let Some(m) = msgs
            .as_array()
            .unwrap()
            .iter()
            .find(|m| m["role"] == "assistant")
        {
            found = Some(m.clone());
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    let m = found.expect("partial assistant message was persisted");
    assert_eq!(m["status"], "partial");
    assert!(m["content"].as_str().unwrap().starts_with('A'));
    let entries = h.get("/api/ledger/entries").await;
    assert_eq!(
        entries.as_array().unwrap().len(),
        1,
        "usage that arrived is recorded"
    );
    assert_eq!(entries[0]["prompt_tokens"], 5);
    h.shutdown().await;
}

#[tokio::test]
async fn threads_sort_by_recent_activity() {
    let fake = fake_hermes("hermes-agent", None).await;
    let h = Harness::start_with(30, &fake.url).await;
    let (_, a) = h.post("/api/threads", json!({})).await;
    let (_, b) = h.post("/api/threads", json!({})).await;
    let ids = |v: &Value| -> Vec<String> {
        v.as_array()
            .unwrap()
            .iter()
            .map(|t| t["id"].as_str().unwrap().to_string())
            .collect()
    };
    let (aid, bid) = (
        a["id"].as_str().unwrap().to_string(),
        b["id"].as_str().unwrap().to_string(),
    );
    assert_eq!(
        ids(&h.get("/api/threads").await),
        [bid.clone(), aid.clone()]
    );
    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    chat_in_thread(&h, &aid, "bump").await;
    assert_eq!(ids(&h.get("/api/threads").await), [aid, bid]);
    h.shutdown().await;
}
