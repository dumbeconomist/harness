mod common;

use std::time::Duration;

use common::*;
use futures::StreamExt;
use reqwest::Method;
use serde_json::{json, Value};

fn text_of(result: &Value) -> String {
    result["content"][0]["text"]
        .as_str()
        .unwrap_or_default()
        .to_string()
}

// ------------------------------------------------------------ auth / http

#[tokio::test]
async fn health_is_open_and_reports_hermes_down() {
    let h = Harness::start().await;
    let r = h.client.get(h.url("/api/health")).send().await.unwrap();
    assert_eq!(r.status(), 200);
    let v: Value = r.json().await.unwrap();
    assert_eq!(v["ok"], true);
    assert!(v["version"].is_string());
    assert_eq!(v["hermes"]["reachable"], false);
    h.shutdown().await;
}

#[tokio::test]
async fn health_reports_hermes_reachable() {
    let fake = fake_hermes("hermes-agent", None).await;
    let h = Harness::start_with(30, &fake.url).await;
    let v: Value = h
        .client
        .get(h.url("/api/health"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(v["hermes"]["reachable"], true);
    h.shutdown().await;
}

#[tokio::test]
async fn auth_is_enforced_on_api_and_mcp() {
    let h = Harness::start().await;
    for (m, p) in [
        (Method::GET, "/api/tasks"),
        (Method::POST, "/api/tasks"),
        (Method::GET, "/api/approvals"),
        (Method::GET, "/api/journal"),
        (Method::GET, "/api/ledger/summary"),
        (Method::GET, "/api/settings/permissions"),
        (Method::GET, "/api/events"),
        (Method::POST, "/api/chat"),
        (Method::POST, "/mcp"),
    ] {
        let r = h.client.request(m.clone(), h.url(p)).send().await.unwrap();
        assert_eq!(r.status(), 401, "{m} {p}");
        let v: Value = r.json().await.unwrap();
        assert_eq!(v["error"]["code"], "unauthorized");
        let r = h
            .client
            .request(m.clone(), h.url(p))
            .bearer_auth("wrong")
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 401, "{m} {p} wrong token");
    }
    // ?token= only works on /api/events
    let r = h
        .client
        .get(h.url("/api/tasks?token=test-token"))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 401);
    let r = h
        .client
        .get(h.url("/api/events?token=nope"))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 401);
    let r = h
        .client
        .get(h.url("/api/events?token=test-token"))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    assert!(r.headers()["content-type"]
        .to_str()
        .unwrap()
        .starts_with("text/event-stream"));
    drop(r);
    h.shutdown().await;
}

#[tokio::test]
async fn cors_allows_local_origins_only() {
    let h = Harness::start().await;
    for origin in [
        "http://localhost:5173",
        "http://127.0.0.1:3000",
        "tauri://localhost",
    ] {
        let r = h
            .client
            .request(Method::OPTIONS, h.url("/api/tasks"))
            .header("origin", origin)
            .header("access-control-request-method", "POST")
            .header(
                "access-control-request-headers",
                "authorization,content-type",
            )
            .send()
            .await
            .unwrap();
        assert!(
            r.status().is_success(),
            "{origin} preflight -> {}",
            r.status()
        );
        assert_eq!(r.headers()["access-control-allow-origin"], origin);
    }
    let r = h
        .client
        .request(Method::OPTIONS, h.url("/api/tasks"))
        .header("origin", "http://evil.example")
        .header("access-control-request-method", "GET")
        .send()
        .await
        .unwrap();
    assert!(r.headers().get("access-control-allow-origin").is_none());
    // Actual responses carry the header too
    let r = h
        .req(Method::GET, "/api/tasks")
        .header("origin", "http://localhost:5173")
        .send()
        .await
        .unwrap();
    assert_eq!(
        r.headers()["access-control-allow-origin"],
        "http://localhost:5173"
    );
    // /mcp refuses foreign browser origins even with a valid token
    let r = h
        .req(Method::POST, "/mcp")
        .header("origin", "http://evil.example")
        .json(&json!({"jsonrpc":"2.0","id":1,"method":"ping"}))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 403);
    h.shutdown().await;
}

#[tokio::test]
async fn error_shape_and_not_found() {
    let h = Harness::start().await;
    let r = h.req(Method::GET, "/api/nope").send().await.unwrap();
    assert_eq!(r.status(), 404);
    let v: Value = r.json().await.unwrap();
    assert!(v["error"]["code"].is_string() && v["error"]["message"].is_string());
    let r = h
        .req(Method::POST, "/api/tasks")
        .body("not json")
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 400);
    let v: Value = r.json().await.unwrap();
    assert_eq!(v["error"]["code"], "bad_request");
    h.shutdown().await;
}

#[tokio::test]
async fn refuses_non_loopback_bind() {
    let dir = tempfile::tempdir().unwrap();
    let mut cfg = common::config(dir.path(), 5, "http://127.0.0.1:1/v1");
    cfg.addr = "0.0.0.0:0".parse().unwrap();
    // (WORKBENCH_ALLOW_REMOTE is not set in the test environment.)
    if std::env::var("WORKBENCH_ALLOW_REMOTE").as_deref() != Ok("1") {
        let err = workbench_core::serve(cfg).await.err().expect("must refuse");
        assert!(err.to_string().contains("non-loopback"));
    }
}

#[cfg(unix)]
#[tokio::test]
async fn generated_token_is_written_with_0600() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let mut cfg = common::config(dir.path(), 5, "http://127.0.0.1:1/v1");
    cfg.token = None;
    let server = workbench_core::serve(cfg).await.unwrap();
    let path = dir.path().join("token");
    let on_disk = std::fs::read_to_string(&path).unwrap();
    assert_eq!(on_disk, server.token);
    assert!(server.token.len() >= 32);
    assert_eq!(
        std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    // and it actually authenticates
    let r = reqwest::Client::new()
        .get(format!("http://{}/api/tasks", server.addr))
        .bearer_auth(&server.token)
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    server.shutdown().await;
}

// ------------------------------------------------------------------- MCP

#[tokio::test]
async fn mcp_initialize_and_tools_list() {
    let h = Harness::start().await;
    let v = h
        .mcp(json!({"jsonrpc":"2.0","id":7,"method":"initialize","params":{
            "protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}))
        .await;
    assert_eq!(v["jsonrpc"], "2.0");
    assert_eq!(v["id"], 7);
    assert_eq!(v["result"]["protocolVersion"], "2025-06-18");
    assert!(v["result"]["serverInfo"]["name"].is_string());
    assert!(v["result"]["capabilities"]["tools"].is_object());

    // notification -> 202, empty body
    let r = h
        .mcp_raw(json!({"jsonrpc":"2.0","method":"notifications/initialized"}))
        .await;
    assert_eq!(r.status(), 202);
    assert!(r.text().await.unwrap().is_empty());

    let v = h
        .mcp(json!({"jsonrpc":"2.0","id":"a","method":"ping"}))
        .await;
    assert_eq!(v["id"], "a");
    assert_eq!(v["result"], json!({}));

    let v = h
        .mcp(json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}))
        .await;
    let tools = v["result"]["tools"].as_array().unwrap();
    let names: Vec<&str> = tools.iter().map(|t| t["name"].as_str().unwrap()).collect();
    assert_eq!(
        names,
        ["tasks_list", "tasks_create", "tasks_update", "tasks_delete"]
    );
    for t in tools {
        assert_eq!(t["inputSchema"]["type"], "object");
        assert!(t["description"].is_string());
    }
    let create = tools.iter().find(|t| t["name"] == "tasks_create").unwrap();
    assert_eq!(create["inputSchema"]["required"][0], "title");
    assert!(create["inputSchema"]["properties"]["idempotency_key"].is_object());
    h.shutdown().await;
}

#[tokio::test]
async fn mcp_protocol_errors() {
    let h = Harness::start().await;
    let v = h
        .mcp(json!({"jsonrpc":"2.0","id":1,"method":"bogus/method"}))
        .await;
    assert_eq!(v["error"]["code"], -32601);
    assert_eq!(v["id"], 1);

    let r = h
        .req(Method::POST, "/mcp")
        .body("{nope")
        .send()
        .await
        .unwrap();
    let v: Value = r.json().await.unwrap();
    assert_eq!(v["error"]["code"], -32700);
    assert!(v["id"].is_null());

    let v = h.mcp(json!({"id":1,"method":"ping"})).await;
    assert_eq!(v["error"]["code"], -32600);

    let v = h
        .mcp(json!([{"jsonrpc":"2.0","id":1,"method":"ping"}]))
        .await;
    assert_eq!(v["error"]["code"], -32600);

    let v = h
        .mcp(json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"nope","arguments":{}}}))
        .await;
    assert_eq!(v["error"]["code"], -32602);

    let v = h
        .mcp(json!({"jsonrpc":"2.0","id":4,"method":"tools/call","params":{}}))
        .await;
    assert_eq!(v["error"]["code"], -32602);

    // bad arguments are a tool error, not a protocol error, and never create an approval
    let r = h
        .call_tool("tasks_create", json!({"notes": "no title"}))
        .await;
    assert_eq!(r["isError"], true);
    let r = h
        .call_tool("tasks_create", json!({"title": "x", "status": "weird"}))
        .await;
    assert_eq!(r["isError"], true);
    let r = h
        .call_tool("tasks_update", json!({"id": "ghost", "title": "x"}))
        .await;
    assert_eq!(r["isError"], true);
    assert!(h.get("/api/approvals").await.as_array().unwrap().is_empty());

    let r = h.req(Method::GET, "/mcp").send().await.unwrap();
    assert_eq!(r.status(), 405);
    h.shutdown().await;
}

#[tokio::test]
async fn tasks_list_is_tier0_and_needs_no_approval() {
    let h = Harness::start().await;
    h.post("/api/tasks", json!({"title": "a"})).await;
    h.post("/api/tasks", json!({"title": "b", "status": "done"}))
        .await;
    let r = h.call_tool("tasks_list", json!({})).await;
    assert!(r.get("isError").is_none());
    assert_eq!(r["structuredContent"]["tasks"].as_array().unwrap().len(), 2);
    let r = h.call_tool("tasks_list", json!({"status": "done"})).await;
    assert_eq!(r["structuredContent"]["tasks"].as_array().unwrap().len(), 1);
    // not journaled (only the two user creates)
    assert_eq!(h.get("/api/journal").await.as_array().unwrap().len(), 2);
    h.shutdown().await;
}

// ------------------------------------------------------- approval gating

#[tokio::test]
async fn create_blocks_until_approved_then_creates() {
    let h = Harness::start().await;
    let call = h.call_tool("tasks_create", json!({"title": "buy milk", "notes": "2%"}));
    let driver = async {
        let a = h.wait_pending().await;
        assert_eq!(a["tool"], "tasks_create");
        assert_eq!(a["tier"], 1);
        assert_eq!(a["status"], "pending");
        assert_eq!(a["requested_by"], "agent");
        assert_eq!(a["args_json"]["title"], "buy milk");
        assert!(a["summary"].as_str().unwrap().contains("buy milk"));
        // nothing exists while the call is blocked
        assert!(h.tasks().await.is_empty());
        let (s, d) = h
            .decide(a["id"].as_str().unwrap(), "approve", Some("go"))
            .await;
        assert_eq!(s, 200);
        assert_eq!(d["status"], "approved");
        assert!(d["decided_at"].is_string());
        // deciding again conflicts
        let (s, _) = h.decide(a["id"].as_str().unwrap(), "deny", None).await;
        assert_eq!(s, 409);
        a["id"].as_str().unwrap().to_string()
    };
    let (result, approval_id) = tokio::join!(call, driver);
    assert!(result.get("isError").is_none(), "{result}");
    let task = &result["structuredContent"]["task"];
    assert_eq!(task["title"], "buy milk");
    assert_eq!(task["notes"], "2%");
    assert_eq!(task["status"], "todo");
    let parsed: Value = serde_json::from_str(&text_of(&result)).unwrap();
    assert_eq!(parsed["task"]["id"], task["id"]);

    let tasks = h.tasks().await;
    assert_eq!(tasks.len(), 1);
    assert_eq!(tasks[0]["id"], task["id"]);

    let j = h.get("/api/journal").await;
    let e = &j.as_array().unwrap()[0];
    assert_eq!(e["tool"], "tasks_create");
    assert_eq!(e["actor"], "agent");
    assert_eq!(e["approval_id"], approval_id);
    assert_eq!(e["inverse_json"]["op"], "delete");
    h.shutdown().await;
}

#[tokio::test]
async fn deny_returns_error_and_creates_nothing() {
    let h = Harness::start().await;
    let call = h.call_tool("tasks_create", json!({"title": "nope"}));
    let driver = async {
        let a = h.wait_pending().await;
        let (s, d) = h
            .decide(a["id"].as_str().unwrap(), "deny", Some("not now"))
            .await;
        assert_eq!(s, 200);
        assert_eq!(d["status"], "denied");
        assert_eq!(d["note"], "not now");
    };
    let (result, _) = tokio::join!(call, driver);
    assert_eq!(result["isError"], true);
    assert_eq!(text_of(&result), "Denied by user: not now");
    assert!(h.tasks().await.is_empty());
    assert!(h.get("/api/journal").await.as_array().unwrap().is_empty());
    h.shutdown().await;
}

#[tokio::test]
async fn approval_times_out_and_expires() {
    let h = Harness::start_with(1, "http://127.0.0.1:1/v1").await;
    let started = std::time::Instant::now();
    let result = h.call_tool("tasks_create", json!({"title": "slow"})).await;
    assert!(started.elapsed() >= Duration::from_millis(900));
    assert!(started.elapsed() < Duration::from_secs(10));
    assert_eq!(result["isError"], true);
    assert!(text_of(&result).to_lowercase().contains("expired"));
    assert!(h.tasks().await.is_empty());
    let all = h.get("/api/approvals").await;
    assert_eq!(all[0]["status"], "expired");
    assert!(h
        .get("/api/approvals?status=pending")
        .await
        .as_array()
        .unwrap()
        .is_empty());
    // late decision is rejected
    let (s, v) = h
        .decide(all[0]["id"].as_str().unwrap(), "approve", None)
        .await;
    assert_eq!(s, 409);
    assert_eq!(v["error"]["code"], "conflict");
    assert!(h.tasks().await.is_empty());
    h.shutdown().await;
}

#[tokio::test]
async fn decision_validation() {
    let h = Harness::start().await;
    let (s, _) = h.decide("missing", "approve", None).await;
    assert_eq!(s, 404);
    let (s, _) = h
        .post("/api/approvals/x/decision", json!({"decision": "maybe"}))
        .await;
    assert_eq!(s, 400);
    assert_eq!(
        h.req(Method::GET, "/api/approvals?status=bogus")
            .send()
            .await
            .unwrap()
            .status(),
        400
    );
    h.shutdown().await;
}

#[tokio::test]
async fn pending_approvals_expire_on_restart() {
    let dir = tempfile::tempdir().unwrap();
    let cfg = common::config(dir.path(), 2, "http://127.0.0.1:1/v1");
    let server = workbench_core::serve(cfg.clone()).await.unwrap();
    let base = format!("http://{}", server.addr);
    let c = reqwest::Client::new();
    let call = {
        let c = c.clone();
        let base = base.clone();
        tokio::spawn(async move {
            c.post(format!("{base}/mcp"))
                .bearer_auth("test-token")
                .json(&json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"tasks_create","arguments":{"title":"x"}}}))
                .send()
                .await
        })
    };
    for _ in 0..100 {
        let a: Value = c
            .get(format!("{base}/api/approvals?status=pending"))
            .bearer_auth("test-token")
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        if !a.as_array().unwrap().is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    server.shutdown().await;
    let _ = call.await;
    let server2 = workbench_core::serve(cfg).await.unwrap();
    let a: Value = c
        .get(format!("http://{}/api/approvals", server2.addr))
        .bearer_auth("test-token")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(a.as_array().unwrap().len(), 1);
    assert_eq!(a[0]["status"], "expired");
    server2.shutdown().await;
}

// ------------------------------------------------------------ idempotency

#[tokio::test]
async fn explicit_idempotency_key_executes_once() {
    let h = Harness::start().await;
    let r1 = h
        .call_and_approve(
            "tasks_create",
            json!({"title": "once", "idempotency_key": "key-1"}),
        )
        .await;
    // Second call returns immediately (no approval needed) with the stored result.
    let r2 = tokio::time::timeout(
        Duration::from_secs(5),
        h.call_tool(
            "tasks_create",
            json!({"title": "once", "idempotency_key": "key-1"}),
        ),
    )
    .await
    .expect("replay must not block on approval");
    assert!(r2.get("isError").is_none());
    assert_eq!(r1["structuredContent"], r2["structuredContent"]);
    assert_eq!(h.tasks().await.len(), 1);
    assert_eq!(h.get("/api/approvals").await.as_array().unwrap().len(), 1);
    let j = h.get("/api/journal").await;
    assert_eq!(j.as_array().unwrap().len(), 1);
    assert_eq!(j[0]["idempotency_key"], "key-1");
    h.shutdown().await;
}

#[tokio::test]
async fn derived_idempotency_key_dedupes_identical_calls() {
    let h = Harness::start().await;
    // Key order differs but canonical args are equal.
    let r1 = h
        .call_and_approve("tasks_create", json!({"title": "dup", "notes": "n"}))
        .await;
    let r2 = tokio::time::timeout(
        Duration::from_secs(5),
        h.call_tool("tasks_create", json!({"notes": "n", "title": "dup"})),
    )
    .await
    .expect("replay must not block");
    assert_eq!(r1["structuredContent"], r2["structuredContent"]);
    assert_eq!(h.tasks().await.len(), 1);
    // different args are a different call
    let r3 = h
        .call_and_approve("tasks_create", json!({"title": "dup2"}))
        .await;
    assert_ne!(
        r3["structuredContent"]["task"]["id"],
        r1["structuredContent"]["task"]["id"]
    );
    assert_eq!(h.tasks().await.len(), 2);
    h.shutdown().await;
}

#[tokio::test]
async fn concurrent_same_key_executes_once() {
    let h = Harness::start().await;
    let args = json!({"title": "race", "idempotency_key": "race-key"});
    let (a, b, _) = tokio::join!(
        h.call_tool("tasks_create", args.clone()),
        h.call_tool("tasks_create", args.clone()),
        async {
            // approve whatever shows up until both calls finish
            for _ in 0..100 {
                let pend = h.get("/api/approvals?status=pending").await;
                for p in pend.as_array().unwrap() {
                    h.decide(p["id"].as_str().unwrap(), "approve", None).await;
                }
                let total = h.get("/api/approvals").await.as_array().unwrap().len();
                let still = h
                    .get("/api/approvals?status=pending")
                    .await
                    .as_array()
                    .unwrap()
                    .len();
                if total >= 2 && still == 0 {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }
    );
    assert!(
        a.get("isError").is_none() && b.get("isError").is_none(),
        "{a} {b}"
    );
    assert_eq!(h.tasks().await.len(), 1, "executed exactly once");
    assert_eq!(a["structuredContent"], b["structuredContent"]);
    h.shutdown().await;
}

// ------------------------------------------------------------------ undo

#[tokio::test]
async fn undo_create_update_delete() {
    let h = Harness::start().await;

    // create via MCP, then undo
    let created = h
        .call_and_approve("tasks_create", json!({"title": "undo me"}))
        .await;
    let id = created["structuredContent"]["task"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let j = h.get("/api/journal").await;
    let create_entry = j[0]["id"].as_str().unwrap().to_string();
    let (s, undone) = h
        .post(&format!("/api/journal/{create_entry}/undo"), json!({}))
        .await;
    assert_eq!(s, 200);
    assert!(undone["undone_at"].is_string());
    assert!(h.tasks().await.is_empty());
    let j = h.get("/api/journal").await;
    assert_eq!(j[0]["tool"], "undo");
    assert_eq!(j[0]["actor"], "user");
    assert_eq!(j[1]["id"], create_entry);
    assert!(j[1]["undone_at"].is_string());
    // already undone / undo-of-undo are 409
    let (s, v) = h
        .post(&format!("/api/journal/{create_entry}/undo"), json!({}))
        .await;
    assert_eq!((s, v["error"]["code"].as_str()), (409, Some("conflict")));
    let undo_id = j[0]["id"].as_str().unwrap().to_string();
    let (s, _) = h
        .post(&format!("/api/journal/{undo_id}/undo"), json!({}))
        .await;
    assert_eq!(s, 409);
    let (s, _) = h.post("/api/journal/ghost/undo", json!({})).await;
    assert_eq!(s, 404);

    // update via MCP, then undo restores the previous values
    let t = h
        .post("/api/tasks", json!({"title": "orig", "notes": "n1"}))
        .await
        .1;
    let tid = t["id"].as_str().unwrap().to_string();
    let upd = h
        .call_and_approve(
            "tasks_update",
            json!({"id": tid, "title": "changed", "status": "doing"}),
        )
        .await;
    assert_eq!(upd["structuredContent"]["task"]["title"], "changed");
    let j = h.get("/api/journal").await;
    assert_eq!(j[0]["tool"], "tasks_update");
    assert_eq!(j[0]["inverse_json"]["op"], "restore");
    let (s, _) = h
        .post(
            &format!("/api/journal/{}/undo", j[0]["id"].as_str().unwrap()),
            json!({}),
        )
        .await;
    assert_eq!(s, 200);
    let tasks = h.tasks().await;
    assert_eq!(tasks[0]["title"], "orig");
    assert_eq!(tasks[0]["status"], "todo");
    assert_eq!(tasks[0]["notes"], "n1");
    assert_eq!(tasks[0]["updated_at"], t["updated_at"]);

    // delete via MCP (tier 2), then undo recreates it identically
    let del = h.call_and_approve("tasks_delete", json!({"id": tid})).await;
    assert_eq!(del["structuredContent"]["deleted"], true);
    assert!(h.tasks().await.is_empty());
    let j = h.get("/api/journal").await;
    assert_eq!(j[0]["tool"], "tasks_delete");
    assert_eq!(j[0]["inverse_json"]["op"], "recreate");
    let (s, _) = h
        .post(
            &format!("/api/journal/{}/undo", j[0]["id"].as_str().unwrap()),
            json!({}),
        )
        .await;
    assert_eq!(s, 200);
    let tasks = h.tasks().await;
    assert_eq!(tasks.len(), 1);
    assert_eq!(tasks[0], t);

    // an identical derived-key call after undo is allowed to run again
    let again = h
        .call_and_approve("tasks_create", json!({"title": "undo me"}))
        .await;
    assert_ne!(again["structuredContent"]["task"]["id"], json!(id));
    h.shutdown().await;
}

#[tokio::test]
async fn user_edits_are_journaled_and_undoable() {
    let h = Harness::start().await;
    let (s, t) = h.post("/api/tasks", json!({"title": "mine"})).await;
    assert_eq!(s, 200);
    let id = t["id"].as_str().unwrap();
    let (s, u) = h
        .send_json(
            Method::PATCH,
            &format!("/api/tasks/{id}"),
            json!({"status": "done"}),
        )
        .await;
    assert_eq!((s, u["status"].as_str()), (200, Some("done")));
    let r = h
        .req(Method::DELETE, &format!("/api/tasks/{id}"))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 204);
    assert!(h.tasks().await.is_empty());
    let j = h.get("/api/journal?limit=10").await;
    let tools: Vec<&str> = j
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["tool"].as_str().unwrap())
        .collect();
    assert_eq!(tools, ["tasks_delete", "tasks_update", "tasks_create"]);
    assert!(j
        .as_array()
        .unwrap()
        .iter()
        .all(|e| e["actor"] == "user" && e["approval_id"].is_null()));
    assert_eq!(
        h.get("/api/journal?limit=1")
            .await
            .as_array()
            .unwrap()
            .len(),
        1
    );
    // errors
    let (s, _) = h
        .send_json(Method::PATCH, "/api/tasks/ghost", json!({"title": "x"}))
        .await;
    assert_eq!(s, 404);
    let (s, _) = h
        .send_json(Method::PATCH, &format!("/api/tasks/{id}"), json!({}))
        .await;
    assert!(s == 400 || s == 404);
    let r = h
        .req(Method::DELETE, "/api/tasks/ghost")
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 404);
    let (s, _) = h.post("/api/tasks", json!({"title": ""})).await;
    assert_eq!(s, 400);
    let (s, _) = h
        .post("/api/tasks", json!({"title": "x", "status": "bogus"}))
        .await;
    assert_eq!(s, 400);
    assert_eq!(
        h.req(Method::GET, "/api/journal?limit=0")
            .send()
            .await
            .unwrap()
            .status(),
        400
    );
    h.shutdown().await;
}

// ---------------------------------------------------------- policy / tiers

#[tokio::test]
async fn tier2_cannot_be_auto_and_tier1_auto_skips_approval() {
    let h = Harness::start().await;
    let p = h.get("/api/settings/policies").await;
    assert_eq!(p["tasks_create"], "ask");
    assert_eq!(p["tasks_delete"], "ask");

    let (s, v) = h
        .put("/api/settings/policies", json!({"tasks_delete": "auto"}))
        .await;
    assert_eq!(s, 400);
    assert_eq!(v["error"]["code"], "bad_request");
    assert_eq!(h.get("/api/settings/policies").await["tasks_delete"], "ask");
    let (s, _) = h
        .put(
            "/api/settings/policies",
            json!({"tasks_create": "sometimes"}),
        )
        .await;
    assert_eq!(s, 400);
    let (s, _) = h
        .put("/api/settings/policies", json!({"ghost_tool": "auto"}))
        .await;
    assert_eq!(s, 400);

    let (s, p) = h
        .put("/api/settings/policies", json!({"tasks_create": "auto"}))
        .await;
    assert_eq!(s, 200);
    assert_eq!(p["tasks_create"], "auto");

    // auto tier-1 runs with no approval and is journaled without approval_id
    let r = tokio::time::timeout(
        Duration::from_secs(5),
        h.call_tool("tasks_create", json!({"title": "auto"})),
    )
    .await
    .expect("auto must not block");
    assert!(r.get("isError").is_none());
    assert_eq!(h.tasks().await.len(), 1);
    assert!(h.get("/api/approvals").await.as_array().unwrap().is_empty());
    let j = h.get("/api/journal").await;
    assert!(j[0]["approval_id"].is_null());
    assert_eq!(j[0]["actor"], "agent");

    // tier 2 still asks even though other tools are auto
    let id = r["structuredContent"]["task"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let del = h.call_and_approve("tasks_delete", json!({"id": id})).await;
    assert_eq!(del["structuredContent"]["deleted"], true);
    assert_eq!(h.get("/api/approvals").await.as_array().unwrap().len(), 1);
    h.shutdown().await;
}

#[tokio::test]
async fn permissions_default_off_and_roundtrip() {
    let h = Harness::start().await;
    let p = h.get("/api/settings/permissions").await;
    for k in ["web", "files", "mail", "terminal", "calendar", "code"] {
        assert_eq!(p[k], false, "{k}");
    }
    let (s, p) = h.put("/api/settings/permissions", json!({"web": true, "files": false, "mail": false, "terminal": false, "calendar": false, "code": false})).await;
    assert_eq!(s, 200);
    assert_eq!(p["web"], true);
    assert_eq!(h.get("/api/settings/permissions").await["web"], true);
    let (s, _) = h
        .put("/api/settings/permissions", json!({"teleport": true}))
        .await;
    assert_eq!(s, 400);
    h.shutdown().await;
}

// -------------------------------------------------------------------- SSE

async fn read_until(resp: reqwest::Response, needle: &str, secs: u64) -> String {
    let mut stream = resp.bytes_stream();
    let mut buf = String::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(secs);
    while !buf.contains(needle) {
        let next = tokio::time::timeout_at(deadline, stream.next())
            .await
            .unwrap_or_else(|_| panic!("timed out; got: {buf}"));
        match next {
            Some(Ok(b)) => buf.push_str(&String::from_utf8_lossy(&b)),
            other => panic!("stream ended early: {other:?}; got: {buf}"),
        }
    }
    buf
}

#[tokio::test]
async fn events_stream_delivers_approval_created_and_friends() {
    let h = Harness::start().await;
    // token via query string, as EventSource would
    let resp = h
        .client
        .get(h.url("/api/events?token=test-token"))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);

    let call = h.call_tool("tasks_create", json!({"title": "live"}));
    let driver = async {
        let a = h.wait_pending().await;
        h.decide(a["id"].as_str().unwrap(), "approve", None).await;
    };
    let reader = read_until(resp, "journal.appended", 10);
    let (_, _, text) = tokio::join!(call, driver, reader);
    let events: Vec<Value> = parse_sse(&text)
        .into_iter()
        .map(|(_, d)| serde_json::from_str(&d).unwrap())
        .collect();
    let types: Vec<&str> = events.iter().map(|e| e["type"].as_str().unwrap()).collect();
    assert!(types.contains(&"approval.created"), "{types:?}");
    assert!(types.contains(&"approval.decided"), "{types:?}");
    assert!(types.contains(&"task.changed"), "{types:?}");
    assert!(types.contains(&"journal.appended"), "{types:?}");
    let created = events
        .iter()
        .find(|e| e["type"] == "approval.created")
        .unwrap();
    assert_eq!(created["payload"]["tool"], "tasks_create");
    assert_eq!(created["payload"]["status"], "pending");
    h.shutdown().await;
}

#[tokio::test]
async fn events_stream_with_bearer_header_and_undo_events() {
    let h = Harness::start().await;
    let resp = h.req(Method::GET, "/api/events").send().await.unwrap();
    assert_eq!(resp.status(), 200);
    let (_, t) = h.post("/api/tasks", json!({"title": "x"})).await;
    let j = h.get("/api/journal").await;
    h.post(
        &format!("/api/journal/{}/undo", j[0]["id"].as_str().unwrap()),
        json!({}),
    )
    .await;
    let _ = t;
    let text = read_until(resp, "journal.undone", 10).await;
    assert!(text.contains("task.changed"));
    h.shutdown().await;
}

#[tokio::test]
async fn shutdown_completes_with_open_event_stream() {
    let h = Harness::start().await;
    let _resp = h.req(Method::GET, "/api/events").send().await.unwrap();
    tokio::time::timeout(Duration::from_secs(5), h.server.shutdown())
        .await
        .expect("shutdown must not hang on SSE clients");
}

// ------------------------------------------------------------------- chat

#[tokio::test]
async fn chat_streams_deltas_and_records_ledger_with_cost() {
    let fake = fake_hermes("claude-sonnet-4-5", None).await;
    let h = Harness::start_with(30, &fake.url).await;
    let resp = h
        .req(Method::POST, "/api/chat")
        .json(&json!({"messages": [{"role": "user", "content": "hi"}]}))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    assert!(resp.headers()["content-type"]
        .to_str()
        .unwrap()
        .starts_with("text/event-stream"));
    let text = resp.text().await.unwrap();
    let evs = parse_sse(&text);
    let deltas: Vec<String> = evs
        .iter()
        .filter(|(e, _)| e == "delta")
        .map(|(_, d)| {
            serde_json::from_str::<Value>(d).unwrap()["text"]
                .as_str()
                .unwrap()
                .to_string()
        })
        .collect();
    assert_eq!(deltas, ["Hel", "lo ", "wörld"]);
    let (last_event, last_data) = evs.last().unwrap();
    assert_eq!(last_event, "done");
    let done: Value = serde_json::from_str(last_data).unwrap();
    assert_eq!(done["usage"]["prompt_tokens"], 1000);
    assert_eq!(done["usage"]["completion_tokens"], 2000);
    assert_eq!(done["usage"]["total_tokens"], 3000);
    // sonnet: 1000*3/1M + 2000*15/1M = 0.033
    assert!((done["usage"]["cost_usd"].as_f64().unwrap() - 0.033).abs() < 1e-9);
    assert!(evs.iter().all(|(e, _)| e != "error"));

    // request sent to Hermes as OpenAI streaming with usage, auth forwarded
    let cap = fake.captured.lock().unwrap().requests.clone();
    assert_eq!(cap.len(), 1);
    let (auth, body, _) = &cap[0];
    assert_eq!(auth.as_deref(), Some("Bearer hermes-secret"));
    assert_eq!(body["stream"], true);
    assert_eq!(body["stream_options"]["include_usage"], true);
    assert_eq!(body["messages"][0]["content"], "hi");

    // ledger recorded before `done` was delivered
    let entries = h.get("/api/ledger/entries").await;
    assert_eq!(entries.as_array().unwrap().len(), 1);
    let e = &entries[0];
    assert_eq!(e["model"], "claude-sonnet-4-5");
    assert_eq!(e["prompt_tokens"], 1000);
    assert_eq!(e["completion_tokens"], 2000);
    assert_eq!(e["source"], "chat");
    assert!((e["cost_usd"].as_f64().unwrap() - 0.033).abs() < 1e-9);

    let s = h.get("/api/ledger/summary").await;
    assert!((s["total_usd"].as_f64().unwrap() - 0.033).abs() < 1e-9);
    assert_eq!(s["by_model"][0]["model"], "claude-sonnet-4-5");
    assert_eq!(s["by_model"][0]["tokens"], 3000);
    assert_eq!(s["by_day"].as_array().unwrap().len(), 1);
    assert_eq!(s["by_day"][0]["day"].as_str().unwrap().len(), 10);
    h.shutdown().await;
}

#[tokio::test]
async fn chat_with_hermes_model_is_unpriced() {
    let fake = fake_hermes("hermes-agent", None).await;
    let h = Harness::start_with(30, &fake.url).await;
    let text = h
        .req(Method::POST, "/api/chat")
        .json(&json!({"messages": [{"role": "user", "content": "hi"}]}))
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert!(parse_sse(&text).iter().any(|(e, _)| e == "done"));
    let e = &h.get("/api/ledger/entries").await[0];
    assert_eq!(e["source"], "unpriced");
    assert_eq!(e["cost_usd"], 0.0);
    assert_eq!(e["completion_tokens"], 2000);
    h.shutdown().await;
}

#[tokio::test]
async fn chat_includes_task_context() {
    let fake = fake_hermes("hermes-agent", None).await;
    let h = Harness::start_with(30, &fake.url).await;
    let (_, t) = h.post("/api/tasks", json!({"title": "ship it"})).await;
    let _ = h
        .req(Method::POST, "/api/chat")
        .json(&json!({"messages": [{"role": "user", "content": "status?"}], "context": {"kind": "task", "id": t["id"]}}))
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    let cap = fake.captured.lock().unwrap().requests.clone();
    let msgs = cap[0].1["messages"].as_array().unwrap();
    assert_eq!(msgs[0]["role"], "system");
    assert!(msgs[0]["content"].as_str().unwrap().contains("ship it"));
    assert_eq!(msgs.len(), 2);
    h.shutdown().await;
}

#[tokio::test]
async fn chat_unreachable_hermes_yields_error_event() {
    let h = Harness::start().await; // Hermes at 127.0.0.1:1 => connection refused
    let resp = h
        .req(Method::POST, "/api/chat")
        .json(&json!({"messages": [{"role": "user", "content": "hi"}]}))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let text = resp.text().await.unwrap();
    let evs = parse_sse(&text);
    assert_eq!(evs.len(), 1, "{text}");
    assert_eq!(evs[0].0, "error");
    let v: Value = serde_json::from_str(&evs[0].1).unwrap();
    assert!(v["message"]
        .as_str()
        .unwrap()
        .to_lowercase()
        .contains("unreachable"));
    assert!(
        !text.contains("hermes-secret"),
        "API key leaked into stream"
    );
    // nothing billed; server still healthy
    assert!(h
        .get("/api/ledger/entries")
        .await
        .as_array()
        .unwrap()
        .is_empty());
    assert_eq!(
        h.client
            .get(h.url("/api/health"))
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    h.shutdown().await;
}

#[tokio::test]
async fn chat_upstream_http_error_yields_error_event() {
    let fake = fake_hermes("hermes-agent", Some(500)).await;
    let h = Harness::start_with(30, &fake.url).await;
    let text = h
        .req(Method::POST, "/api/chat")
        .json(&json!({"messages": [{"role": "user", "content": "hi"}]}))
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    let evs = parse_sse(&text);
    assert_eq!(evs[0].0, "error");
    assert!(evs[0].1.contains("500"));
    assert!(h
        .get("/api/ledger/entries")
        .await
        .as_array()
        .unwrap()
        .is_empty());
    h.shutdown().await;
}

#[tokio::test]
async fn chat_validates_input() {
    let h = Harness::start().await;
    let (s, _) = h.post("/api/chat", json!({"messages": []})).await;
    assert_eq!(s, 400);
    let (s, _) = h
        .post(
            "/api/chat",
            json!({"messages": [{"role": "robot", "content": "x"}]}),
        )
        .await;
    assert_eq!(s, 400);
    let (s, _) = h.post("/api/chat", json!({"nope": 1})).await;
    assert_eq!(s, 400);
    h.shutdown().await;
}

// ---------------------------------------------------------------- misc

#[tokio::test]
async fn data_persists_across_restart() {
    let dir = tempfile::tempdir().unwrap();
    let cfg = common::config(dir.path(), 5, "http://127.0.0.1:1/v1");
    let s1 = workbench_core::serve(cfg.clone()).await.unwrap();
    let c = reqwest::Client::new();
    c.post(format!("http://{}/api/tasks", s1.addr))
        .bearer_auth("test-token")
        .json(&json!({"title": "durable"}))
        .send()
        .await
        .unwrap();
    s1.shutdown().await;
    let s2 = workbench_core::serve(cfg).await.unwrap();
    let t: Value = c
        .get(format!("http://{}/api/tasks", s2.addr))
        .bearer_auth("test-token")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(t[0]["title"], "durable");
    s2.shutdown().await;
}

#[tokio::test]
async fn tasks_status_filter() {
    let h = Harness::start().await;
    h.post("/api/tasks", json!({"title": "a"})).await;
    h.post("/api/tasks", json!({"title": "b", "status": "doing"}))
        .await;
    assert_eq!(
        h.get("/api/tasks?status=doing")
            .await
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(h.get("/api/tasks").await.as_array().unwrap().len(), 2);
    assert_eq!(
        h.req(Method::GET, "/api/tasks?status=zzz")
            .send()
            .await
            .unwrap()
            .status(),
        400
    );
    h.shutdown().await;
}

// ------------------------------------------------- Hermes spike contract

#[tokio::test]
async fn mcp_negotiates_protocol_versions_and_session_header() {
    let h = Harness::start().await;
    for (asked, expect) in [
        ("2025-11-25", "2025-11-25"),
        ("2025-06-18", "2025-06-18"),
        ("2099-01-01", "2025-06-18"),
        ("2024-11-05", "2025-06-18"),
    ] {
        let r = h
            .req(Method::POST, "/mcp")
            .header("MCP-Protocol-Version", asked)
            .header("accept", "application/json, text/event-stream")
            .json(&json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":asked}}))
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 200);
        assert!(r.headers()["content-type"]
            .to_str()
            .unwrap()
            .starts_with("application/json"));
        assert!(r.headers().get("mcp-session-id").is_some());
        let v: Value = r.json().await.unwrap();
        assert_eq!(v["result"]["protocolVersion"], expect, "asked {asked}");
    }
    // later requests need no session id and accept the version header
    let r = h
        .req(Method::POST, "/mcp")
        .header("MCP-Protocol-Version", "2025-11-25")
        .json(&json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    h.shutdown().await;
}

#[tokio::test]
async fn mcp_get_head_delete_semantics() {
    let h = Harness::start().await;
    let c = &h.client;
    for m in [Method::GET, Method::HEAD, Method::DELETE] {
        let r = c.request(m.clone(), h.url("/mcp")).send().await.unwrap();
        assert_eq!(r.status(), 401, "{m} without auth");
    }
    for m in [Method::GET, Method::HEAD] {
        let r = tokio::time::timeout(
            Duration::from_secs(2),
            h.req(m.clone(), "/mcp")
                .header("accept", "text/event-stream")
                .send(),
        )
        .await
        .expect("must answer quickly")
        .unwrap();
        assert_eq!(r.status(), 405, "{m}");
    }
    let r = h
        .req(Method::DELETE, "/mcp")
        .header("mcp-session-id", "abc")
        .send()
        .await
        .unwrap();
    assert!(r.status() == 204 || r.status() == 200);
    h.shutdown().await;
}

#[tokio::test]
async fn chat_forwards_tool_progress_and_session_id() {
    let fake = fake_hermes("hermes-agent", None).await;
    let h = Harness::start_with(30, &fake.url).await;
    let text = h
        .req(Method::POST, "/api/chat")
        .json(&json!({"messages": [{"role": "user", "content": "hi"}], "session_id": "sess-42"}))
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    let evs = parse_sse(&text);
    let tool: Vec<_> = evs.iter().filter(|(e, _)| e == "tool").collect();
    assert_eq!(tool.len(), 1, "{text}");
    let v: Value = serde_json::from_str(&tool[0].1).unwrap();
    assert_eq!(v["tool"], "mcp__workbench__tasks_create");
    assert_eq!(v["status"], "running");
    // unknown named events and keepalives are ignored; deltas/done unaffected
    assert_eq!(evs.iter().filter(|(e, _)| e == "delta").count(), 3);
    assert_eq!(evs.last().unwrap().0, "done");
    assert!(evs.iter().all(|(e, _)| e != "error" && e != "hermes.other"));
    let cap = fake.captured.lock().unwrap().requests.clone();
    assert_eq!(cap[0].2.as_deref(), Some("sess-42"));
    h.shutdown().await;
}
