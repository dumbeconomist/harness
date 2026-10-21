//! Connection doctor: tracks what Hermes has done with us and checks the link.
//!
//! Last-seen times live in memory and in the `settings` table (key `doctor`) so
//! a restart of Workbench does not make it forget that Hermes once connected.

use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::brain::DEFAULT_MODEL;
use crate::db::{self, now, Db};
use crate::state::{HermesRuntime, SharedState};

const SETTING_KEY: &str = "doctor";
const PROBE_TIMEOUT: Duration = Duration::from_secs(3);
const MODEL_TIMEOUT: Duration = Duration::from_secs(8);

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct BrainError {
    pub at: String,
    pub status: Option<u16>,
    pub message: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Snapshot {
    pub mcp_last_initialize_at: Option<String>,
    pub mcp_last_tools_list_at: Option<String>,
    pub mcp_last_tool_call_at: Option<String>,
    pub mcp_client_info: Option<Value>,
    pub brain_last_ok_at: Option<String>,
    pub brain_last_error: Option<BrainError>,
}

pub struct Doctor {
    inner: Mutex<Snapshot>,
    deep: Mutex<Option<DeepCache>>,
}

/// The last deep model check, kept in memory so the next plain poll still shows it.
struct DeepCache {
    at: std::time::Instant,
    url: String,
    key: Option<String>,
    check: Check,
}

/// How long a deep result is still shown by non-deep runs.
pub const DEEP_TTL: Duration = Duration::from_secs(600);

fn clip(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

/// Keep only short string fields of an MCP `clientInfo`.
fn sanitize_client_info(v: &Value) -> Option<Value> {
    let o = v.as_object()?;
    let mut out = serde_json::Map::new();
    for k in ["name", "title", "version"] {
        if let Some(s) = o.get(k).and_then(Value::as_str) {
            out.insert(k.into(), json!(clip(s, 100)));
        }
    }
    (!out.is_empty()).then_some(Value::Object(out))
}

impl Doctor {
    pub fn load(db: &Db) -> Doctor {
        let snap = db
            .with(|c| db::get_setting(c, SETTING_KEY))
            .ok()
            .flatten()
            .and_then(|v| serde_json::from_value(v).ok())
            .unwrap_or_default();
        Doctor {
            inner: Mutex::new(snap),
            deep: Mutex::new(None),
        }
    }

    fn store_deep(&self, h: &HermesRuntime, check: Check) {
        *self.deep.lock().unwrap_or_else(|e| e.into_inner()) = Some(DeepCache {
            at: std::time::Instant::now(),
            url: h.url.clone(),
            key: h.api_key.clone(),
            check,
        });
    }

    /// The cached deep check if it is younger than `ttl` and Hermes settings are unchanged.
    fn cached_deep(&self, h: &HermesRuntime, ttl: Duration) -> Option<Check> {
        let g = self.deep.lock().unwrap_or_else(|e| e.into_inner());
        let c = g.as_ref()?;
        (c.at.elapsed() < ttl && c.url == h.url && c.key == h.api_key).then(|| c.check.clone())
    }

    pub fn snapshot(&self) -> Snapshot {
        self.inner.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// Mutate and persist under one lock so persisted order matches memory.
    fn update(&self, db: &Db, f: impl FnOnce(&mut Snapshot)) {
        let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        f(&mut g);
        let v = serde_json::to_value(&*g).unwrap_or(Value::Null);
        if let Err(e) = db.with(|c| db::set_setting(c, SETTING_KEY, &v)) {
            tracing::warn!("could not persist doctor state: {}", e.message);
        }
    }

    pub fn mcp_initialize(&self, db: &Db, params: &Value) {
        let info = params.get("clientInfo").and_then(sanitize_client_info);
        self.update(db, |s| {
            s.mcp_last_initialize_at = Some(now());
            if info.is_some() {
                s.mcp_client_info = info;
            }
        });
    }

    pub fn mcp_tools_list(&self, db: &Db) {
        self.update(db, |s| s.mcp_last_tools_list_at = Some(now()));
    }

    pub fn mcp_tool_call(&self, db: &Db) {
        self.update(db, |s| s.mcp_last_tool_call_at = Some(now()));
    }

    pub fn brain_ok(&self, db: &Db) {
        self.update(db, |s| s.brain_last_ok_at = Some(now()));
    }

    pub fn brain_error(&self, db: &Db, status: Option<u16>, message: &str) {
        self.update(db, |s| {
            s.brain_last_error = Some(BrainError {
                at: now(),
                status,
                message: clip(message, 300),
            })
        });
    }
}

/// Pull the status out of the brain's "Hermes returned HTTP 401 ...: body" errors.
pub fn status_from_message(msg: &str) -> Option<u16> {
    let rest = msg.split("HTTP ").nth(1)?;
    rest.get(..3)?.parse().ok()
}

/// Replace every known secret in `s` with `***`.
fn redact(s: &str, secrets: &[&str]) -> String {
    let mut out = s.to_string();
    for sec in secrets.iter().filter(|x| x.len() >= 4) {
        out = out.replace(sec, "***");
    }
    out
}

/// Redact the Hermes key, UI token and MCP token.
pub fn redact_secrets(st: &SharedState, s: &str) -> String {
    let h = st.hermes();
    let secrets: Vec<&str> = [
        h.api_key.as_deref(),
        Some(st.token.as_str()),
        Some(st.mcp_token.as_str()),
    ]
    .into_iter()
    .flatten()
    .collect();
    redact(s, &secrets)
}

/// The single point where a brain error is recorded: secrets are removed
/// before the message is stored. Returns the redacted message for callers
/// that show it (SSE, doctor).
pub fn record_brain_error(st: &SharedState, status: Option<u16>, message: &str) -> String {
    let msg = redact_secrets(st, message);
    st.doctor.brain_error(&st.db, status, &msg);
    msg
}

/// Friendly text for a transport failure, plus the raw error as detail.
fn friendly_transport(e: reqwest::Error, url: &str) -> (String, String) {
    let timeout = e.is_timeout();
    let detail = e.without_url().to_string();
    let msg = if timeout {
        format!("Hermes at {url} didn't answer in time. Is the gateway running?")
    } else {
        format!("Can't reach Hermes at {url}. Is the gateway running?")
    };
    (msg, detail)
}

/// `GET {HERMES_URL}/models`; records the outcome as brain ok/error. Any HTTP
/// answer is `Ok(status)`; only a transport failure is `Err((friendly, raw))`.
pub async fn probe_models(
    st: &SharedState,
    h: &HermesRuntime,
    timeout: Duration,
) -> Result<u16, (String, String)> {
    let url = format!("{}/models", h.url.trim_end_matches('/'));
    let mut rb = st.http.get(url).timeout(timeout);
    if let Some(k) = &h.api_key {
        rb = rb.bearer_auth(k);
    }
    match rb.send().await {
        Ok(r) => {
            let code = r.status().as_u16();
            if r.status().is_success() {
                st.doctor.brain_ok(&st.db);
            } else {
                record_brain_error(st, Some(code), &format!("HTTP {code} from /models"));
            }
            Ok(code)
        }
        Err(e) => {
            let (friendly, detail) = friendly_transport(e, &h.url);
            record_brain_error(st, None, &detail);
            Err((friendly, detail))
        }
    }
}

// ------------------------------------------------------------------ report

#[derive(Debug, Clone, Serialize)]
pub struct Check {
    pub id: &'static str,
    pub title: &'static str,
    pub status: &'static str,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fix: Option<String>,
    /// Raw technical error, for the curious.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// Set on a deep result replayed from the cache.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checked_at: Option<String>,
    pub blocking: bool,
}

#[derive(Debug, Serialize)]
pub struct Report {
    pub ok: bool,
    pub checks: Vec<Check>,
}

struct Builder {
    checks: Vec<Check>,
    blocked: bool,
}

const T_API: &str = "Hermes API";
const T_KEY: &str = "API key";
const T_MODEL: &str = "Model";
const T_CONN: &str = "Connection to Workbench";
const T_TOOLS: &str = "Workbench tools";
const T_LOCK: &str = "Profile lock";

impl Builder {
    #[allow(clippy::too_many_arguments)]
    fn add(
        &mut self,
        id: &'static str,
        title: &'static str,
        blocking: bool,
        status: &'static str,
        message: impl Into<String>,
        fix: Option<&str>,
        detail: Option<String>,
    ) {
        if status == "fail" && blocking {
            self.blocked = true;
        }
        self.checks.push(Check {
            id,
            title,
            status,
            message: message.into(),
            fix: fix.map(String::from),
            detail,
            checked_at: None,
            blocking,
        });
    }

    fn push(
        &mut self,
        id: &'static str,
        title: &'static str,
        blocking: bool,
        status: &'static str,
        message: impl Into<String>,
        fix: Option<&str>,
    ) {
        self.add(id, title, blocking, status, message, fix, None);
    }

    fn skip_with(&mut self, id: &'static str, title: &'static str, blocking: bool, message: &str) {
        self.push(id, title, blocking, "skip", message, None);
    }

    fn skip(&mut self, id: &'static str, title: &'static str, blocking: bool) {
        self.skip_with(
            id,
            title,
            blocking,
            "Skipped until the earlier problem is fixed.",
        );
    }
}

const FIX_START: &str = "Start the locked profile: `hermes -p workbench gateway run`";
const FIX_KEY: &str = "Paste the profile's API_SERVER_KEY in Settings → Hermes";
const FIX_MCP: &str = "Add WORKBENCH_MCP_TOKEN to the profile .env and restart the gateway";
const FIX_TOOLS: &str = "Check `mcp_servers.workbench` in the profile config.yaml";
const FIX_LOCKED: &str = "Use the locked profile (README step 1)";

/// Parse a `/toolsets` body into `(name, enabled)` pairs. Accepts an array of
/// `{name, enabled}`, an object `{name: {enabled}}` (or `{name: bool}`), and
/// either wrapped under `toolsets` / `data` / `items`. `None` = unrecognised.
fn toolset_entries(v: &Value) -> Option<Vec<(String, bool)>> {
    match v {
        Value::Array(a) => Some(
            a.iter()
                .filter_map(|it| {
                    let o = it.as_object()?;
                    let name = ["name", "id", "toolset"]
                        .iter()
                        .find_map(|k| o.get(*k).and_then(Value::as_str))?;
                    let en = o.get("enabled").and_then(Value::as_bool).unwrap_or(false);
                    Some((name.to_string(), en))
                })
                .collect(),
        ),
        Value::Object(o) => {
            for k in ["toolsets", "data", "items"] {
                if let Some(inner) = o.get(k).filter(|x| x.is_array() || x.is_object()) {
                    return toolset_entries(inner);
                }
            }
            Some(
                o.iter()
                    .filter_map(|(name, val)| {
                        let en = match val {
                            Value::Object(m) => m.get("enabled").and_then(Value::as_bool)?,
                            Value::Bool(b) => *b,
                            _ => return None,
                        };
                        Some((name.clone(), en))
                    })
                    .collect(),
            )
        }
        _ => None,
    }
}

fn dangerous_enabled(entries: &[(String, bool)]) -> Vec<String> {
    entries
        .iter()
        .filter(|(n, en)| {
            *en && matches!(
                n.trim().to_ascii_lowercase().as_str(),
                "terminal" | "file" | "files"
            )
        })
        .map(|(n, _)| n.clone())
        .collect()
}

/// Ok, or `(message, detail)` for a failed deep check.
async fn check_deep_model(
    st: &SharedState,
    h: &HermesRuntime,
) -> Result<(), (String, Option<String>)> {
    let url = format!("{}/chat/completions", h.url.trim_end_matches('/'));
    let mut rb = st.http.post(url).timeout(MODEL_TIMEOUT).json(&json!({
        "model": st.hermes_model.clone().unwrap_or_else(|| DEFAULT_MODEL.to_string()),
        "messages": [{"role": "user", "content": "ping"}],
        "max_tokens": 1,
        "stream": false,
    }));
    if let Some(k) = &h.api_key {
        rb = rb.bearer_auth(k);
    }
    let resp = rb.send().await.map_err(|e| {
        let (friendly, detail) = friendly_transport(e, &h.url);
        record_brain_error(st, None, &detail);
        (friendly, Some(detail))
    })?;
    let code = resp.status().as_u16();
    if resp.status().is_success() {
        st.doctor.brain_ok(&st.db);
        return Ok(());
    }
    let text = resp.text().await.unwrap_or_default();
    let upstream = serde_json::from_str::<Value>(&text)
        .ok()
        .and_then(|v| {
            v["error"]["message"]
                .as_str()
                .or_else(|| v["error"].as_str())
                .map(String::from)
        })
        .unwrap_or_else(|| clip(&text, 300));
    let upstream = record_brain_error(st, Some(code), &clip(&upstream, 300));
    Err((
        format!("Hermes answered HTTP {code}: {upstream}"),
        Some(upstream),
    ))
}

pub async fn run(st: &SharedState, deep: bool) -> Report {
    let h = st.hermes();
    let snap = st.doctor.snapshot();
    let mut b = Builder {
        checks: Vec::new(),
        blocked: false,
    };

    // hermes_reachable + hermes_auth share one request.
    let probe = probe_models(st, &h, PROBE_TIMEOUT).await;
    match &probe {
        Err((friendly, detail)) => b.add(
            "hermes_reachable",
            T_API,
            true,
            "fail",
            friendly.clone(),
            Some(FIX_START),
            Some(detail.clone()),
        ),
        Ok(code) if *code >= 500 => b.push(
            "hermes_reachable",
            T_API,
            true,
            "warn",
            format!("Hermes answered with an error (HTTP {code})"),
            None,
        ),
        Ok(code) => b.push(
            "hermes_reachable",
            T_API,
            true,
            "ok",
            format!("Hermes answered at {} (HTTP {code})", h.url),
            None,
        ),
    }
    if b.blocked {
        b.skip("hermes_auth", T_KEY, true);
    } else {
        match probe {
            Ok(401) | Ok(403) => b.push(
                "hermes_auth",
                T_KEY,
                true,
                "fail",
                format!(
                    "Hermes rejected the API key ({})",
                    if h.api_key.is_some() {
                        "the saved key is wrong"
                    } else {
                        "no key is set"
                    }
                ),
                Some(FIX_KEY),
            ),
            Ok(code) if code >= 500 => b.skip_with(
                "hermes_auth",
                T_KEY,
                true,
                "Can't tell while Hermes is erroring",
            ),
            _ => b.push(
                "hermes_auth",
                T_KEY,
                true,
                "ok",
                "The API key is accepted",
                None,
            ),
        }
    }

    // hermes_model: deep runs it; plain runs replay a recent deep result.
    if b.blocked {
        b.skip("hermes_model", T_MODEL, true);
    } else if deep {
        let id = "hermes_model";
        match check_deep_model(st, &h).await {
            Ok(()) => b.push(
                id,
                T_MODEL,
                true,
                "ok",
                "The model answered a 1-token test request",
                None,
            ),
            Err((msg, detail)) => b.add(
                id,
                T_MODEL,
                true,
                "fail",
                msg,
                Some("Check the model and provider configured in the Workbench Hermes profile"),
                detail,
            ),
        }
        let last = b.checks.last_mut().expect("just pushed");
        last.checked_at = Some(now());
        st.doctor.store_deep(&h, last.clone());
    } else if let Some(mut c) = st.doctor.cached_deep(&h, DEEP_TTL) {
        // Cached message was redacted when built; the final pass redacts again.
        if c.status == "fail" {
            b.blocked = true;
        }
        c.message = format!("{} (deep check)", c.message);
        b.checks.push(c);
    } else {
        b.skip_with(
            "hermes_model",
            T_MODEL,
            true,
            "Not tested. Run the deep check to send a 1-token request.",
        );
    }

    // mcp_connected / mcp_tools_seen
    if b.blocked {
        b.skip("mcp_connected", T_CONN, false);
        b.skip("mcp_tools_seen", T_TOOLS, false);
    } else {
        match &snap.mcp_last_initialize_at {
            Some(at) => {
                let who = snap
                    .mcp_client_info
                    .as_ref()
                    .and_then(|c| c["name"].as_str())
                    .map(|n| format!(" as {n}"))
                    .unwrap_or_default();
                b.push(
                    "mcp_connected",
                    T_CONN,
                    false,
                    "ok",
                    format!("Hermes connected{who}; last seen {at}"),
                    None,
                );
                match &snap.mcp_last_tools_list_at {
                    Some(at) => b.push(
                        "mcp_tools_seen",
                        T_TOOLS,
                        false,
                        "ok",
                        format!("Hermes listed Workbench's tools; last seen {at}"),
                        None,
                    ),
                    None => b.push(
                        "mcp_tools_seen",
                        T_TOOLS,
                        false,
                        "warn",
                        "Hermes connected but never listed tools",
                        Some(FIX_TOOLS),
                    ),
                }
            }
            None => {
                b.push(
                    "mcp_connected",
                    T_CONN,
                    false,
                    "warn",
                    "Hermes hasn't connected to Workbench yet",
                    Some(FIX_MCP),
                );
                b.skip_with(
                    "mcp_tools_seen",
                    T_TOOLS,
                    false,
                    "Waiting for Hermes to connect",
                );
            }
        }
    }

    // profile_locked
    if b.blocked {
        b.skip("profile_locked", T_LOCK, true);
    } else {
        let url = format!("{}/toolsets", h.url.trim_end_matches('/'));
        let mut rb = st.http.get(url).timeout(PROBE_TIMEOUT);
        if let Some(k) = &h.api_key {
            rb = rb.bearer_auth(k);
        }
        let id = "profile_locked";
        match rb.send().await {
            Err(e) => {
                let (_, detail) = friendly_transport(e, &h.url);
                b.add(
                    id,
                    T_LOCK,
                    true,
                    "warn",
                    "Can't verify the profile: Hermes didn't answer",
                    None,
                    Some(detail),
                );
            }
            Ok(r) if r.status().as_u16() == 404 => b.push(
                id,
                T_LOCK,
                true,
                "warn",
                "This Hermes has no /toolsets endpoint, so Workbench can't verify the profile is locked",
                Some(FIX_LOCKED),
            ),
            Ok(r) if !r.status().is_success() => b.push(
                id,
                T_LOCK,
                true,
                "warn",
                format!(
                    "Can't verify the profile: /toolsets answered HTTP {}",
                    r.status().as_u16()
                ),
                None,
            ),
            Ok(r) => match r
                .json::<Value>()
                .await
                .ok()
                .as_ref()
                .and_then(toolset_entries)
            {
                None => b.push(
                    id,
                    T_LOCK,
                    true,
                    "warn",
                    "Can't verify the profile: unrecognised /toolsets response",
                    None,
                ),
                Some(entries) => {
                    let bad = dangerous_enabled(&entries);
                    if bad.is_empty() {
                        b.push(
                            id,
                            T_LOCK,
                            true,
                            "ok",
                            "Hermes' own terminal and file tools are off",
                            None,
                        );
                    } else {
                        b.push(
                            id,
                            T_LOCK,
                            true,
                            "fail",
                            format!(
                                "Hermes can use its own {} tools, which bypass Workbench approvals",
                                bad.join("/")
                            ),
                            Some(FIX_LOCKED),
                        );
                    }
                }
            },
        }
    }

    // Never leak secrets, whatever the upstream echoed back.
    for c in &mut b.checks {
        c.message = redact_secrets(st, &c.message);
        c.fix = c.fix.as_deref().map(|f| redact_secrets(st, f));
        c.detail = c.detail.as_deref().map(|f| redact_secrets(st, f));
    }
    let ok = !b.checks.iter().any(|c| c.blocking && c.status == "fail");
    Report {
        ok,
        checks: b.checks,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn toolset_shapes() {
        let arr = json!([{"name":"terminal","enabled":true},{"name":"web","enabled":false}]);
        let e = toolset_entries(&arr).unwrap();
        assert_eq!(dangerous_enabled(&e), ["terminal"]);
        let obj = json!({"file":{"enabled":true},"terminal":{"enabled":false}});
        assert_eq!(dangerous_enabled(&toolset_entries(&obj).unwrap()), ["file"]);
        let wrapped = json!({"toolsets":[{"name":"Terminal","enabled":true}]});
        assert_eq!(
            dangerous_enabled(&toolset_entries(&wrapped).unwrap()),
            ["Terminal"]
        );
        let flags = json!({"terminal": false, "web": true});
        assert!(dangerous_enabled(&toolset_entries(&flags).unwrap()).is_empty());
        assert!(toolset_entries(&json!("nope")).is_none());
        assert!(toolset_entries(&json!([])).unwrap().is_empty());
    }

    #[test]
    fn status_parse_and_redact() {
        assert_eq!(
            status_from_message("Hermes returned HTTP 401 Unauthorized: x"),
            Some(401)
        );
        assert_eq!(status_from_message("Hermes is unreachable"), None);
        assert_eq!(redact("key=abcd1234!", &["abcd1234"]), "key=***!");
    }

    #[test]
    fn deep_cache_expires_and_tracks_settings() {
        let db = Db::open_memory().unwrap();
        let d = Doctor::load(&db);
        let h = HermesRuntime {
            url: "http://a/v1".into(),
            api_key: Some("k".into()),
        };
        let c = Check {
            id: "hermes_model",
            title: T_MODEL,
            status: "ok",
            message: "m".into(),
            fix: None,
            detail: None,
            checked_at: Some(now()),
            blocking: true,
        };
        assert!(d.cached_deep(&h, DEEP_TTL).is_none());
        d.store_deep(&h, c);
        assert!(d.cached_deep(&h, DEEP_TTL).is_some());
        assert!(d.cached_deep(&h, Duration::ZERO).is_none());
        let other = HermesRuntime {
            url: "http://b/v1".into(),
            ..h.clone()
        };
        assert!(d.cached_deep(&other, DEEP_TTL).is_none());
    }

    #[test]
    fn persists_and_reloads() {
        let db = Db::open_memory().unwrap();
        let d = Doctor::load(&db);
        d.mcp_initialize(
            &db,
            &json!({"clientInfo":{"name":"hermes","version":"1","x":2}}),
        );
        d.brain_error(&db, Some(401), "nope");
        let again = Doctor::load(&db).snapshot();
        assert!(again.mcp_last_initialize_at.is_some());
        assert_eq!(
            again.mcp_client_info.unwrap(),
            json!({"name":"hermes","version":"1"})
        );
        assert_eq!(again.brain_last_error.unwrap().status, Some(401));
    }
}
