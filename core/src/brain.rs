//! Brain adapter: an OpenAI-compatible streaming chat client (Hermes).

use std::pin::Pin;
use std::time::Duration;

use futures::{Stream, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const DEFAULT_MODEL: &str = "hermes-agent";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone)]
pub struct ChatRequest {
    pub messages: Vec<ChatMessage>,
    pub model: Option<String>,
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct Usage {
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub enum BrainEvent {
    Delta(String),
    ToolProgress { tool: String, status: String },
    Done { usage: Usage, model: String },
    Error(String),
}

pub type BrainStream = Pin<Box<dyn Stream<Item = BrainEvent> + Send>>;

pub trait Brain: Send + Sync {
    fn chat_stream(&self, req: ChatRequest) -> BrainStream;
}

pub struct HermesBrain {
    client: reqwest::Client,
    base_url: String,
    api_key: Option<String>,
    default_model: String,
}

impl HermesBrain {
    pub fn new(base_url: &str, api_key: Option<String>, default_model: Option<String>) -> Self {
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .build()
            .unwrap_or_default();
        Self {
            client,
            base_url: base_url.trim_end_matches('/').to_string(),
            api_key,
            default_model: default_model.unwrap_or_else(|| DEFAULT_MODEL.to_string()),
        }
    }
}

/// Incremental SSE line splitter: feed raw bytes, get complete `data:` payloads.
#[derive(Default)]
pub struct SseParser {
    buf: Vec<u8>,
    event: Option<String>,
}

impl SseParser {
    /// Returns `(event name, data)` pairs; comment lines (`: keepalive`) are skipped.
    pub fn feed(&mut self, bytes: &[u8]) -> Vec<(Option<String>, String)> {
        self.buf.extend_from_slice(bytes);
        let mut out = Vec::new();
        while let Some(pos) = self.buf.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = self.buf.drain(..=pos).collect();
            let line = String::from_utf8_lossy(&line);
            let line = line.trim_end_matches(['\n', '\r']);
            if line.is_empty() {
                self.event = None;
            } else if let Some(rest) = line.strip_prefix("event:") {
                self.event = Some(rest.trim().to_string());
            } else if let Some(rest) = line.strip_prefix("data:") {
                out.push((
                    self.event.clone(),
                    rest.strip_prefix(' ').unwrap_or(rest).to_string(),
                ));
            }
        }
        out
    }
}

#[derive(Default)]
struct Acc {
    model: Option<String>,
    usage: Option<Usage>,
    got_data: bool,
}

enum Parsed {
    Delta(String),
    Error(String),
    Nothing,
}

fn interpret(chunk: &Value, acc: &mut Acc) -> Parsed {
    if let Some(err) = chunk.get("error").filter(|e| !e.is_null()) {
        let msg = err
            .get("message")
            .and_then(Value::as_str)
            .or_else(|| err.as_str())
            .unwrap_or("upstream error");
        return Parsed::Error(msg.to_string());
    }
    if let Some(m) = chunk.get("model").and_then(Value::as_str) {
        if !m.is_empty() {
            acc.model = Some(m.to_string());
        }
    }
    if let Some(u) = chunk.get("usage").filter(|u| u.is_object()) {
        acc.usage = Some(Usage {
            prompt_tokens: u["prompt_tokens"].as_i64().unwrap_or(0),
            completion_tokens: u["completion_tokens"].as_i64().unwrap_or(0),
        });
    }
    match chunk["choices"][0]["delta"]["content"].as_str() {
        Some(t) if !t.is_empty() => Parsed::Delta(t.to_string()),
        _ => Parsed::Nothing,
    }
}

impl Brain for HermesBrain {
    fn chat_stream(&self, req: ChatRequest) -> BrainStream {
        let client = self.client.clone();
        let url = format!("{}/chat/completions", self.base_url);
        let key = self.api_key.clone();
        let session_id = req.session_id.clone();
        let model = req.model.unwrap_or_else(|| self.default_model.clone());
        let body = json!({
            "model": model,
            "messages": req.messages,
            "stream": true,
            "stream_options": {"include_usage": true},
        });
        Box::pin(async_stream::stream! {
            let mut rb = client.post(&url).json(&body);
            if let Some(sid) = &session_id {
                rb = rb.header("X-Hermes-Session-Id", sid);
            }
            if let Some(k) = &key {
                rb = rb.bearer_auth(k);
            }
            let resp = match rb.send().await {
                Ok(r) => r,
                Err(e) => {
                    yield BrainEvent::Error(format!("Hermes is unreachable at {}: {}", url, e.without_url()));
                    return;
                }
            };
            if !resp.status().is_success() {
                let status = resp.status();
                let text = resp.text().await.unwrap_or_default();
                let snippet: String = text.chars().take(300).collect();
                yield BrainEvent::Error(format!("Hermes returned HTTP {status}: {snippet}"));
                return;
            }
            let mut parser = SseParser::default();
            let mut acc = Acc::default();
            let mut bytes = resp.bytes_stream();
            let mut finished = false;
            'outer: loop {
                let next = tokio::time::timeout(Duration::from_secs(120), bytes.next()).await;
                let chunk = match next {
                    Err(_) => {
                        yield BrainEvent::Error("Hermes stream timed out".into());
                        return;
                    }
                    Ok(None) => break,
                    Ok(Some(Err(e))) => {
                        yield BrainEvent::Error(format!("Hermes stream error: {}", e.without_url()));
                        return;
                    }
                    Ok(Some(Ok(c))) => c,
                };
                for (event, data) in parser.feed(&chunk) {
                    let data = data.trim();
                    match event.as_deref() {
                        None | Some("message") => {}
                        Some("hermes.tool.progress") => {
                            if let Ok(v) = serde_json::from_str::<Value>(data) {
                                if let Some(tool) = v["tool"].as_str() {
                                    yield BrainEvent::ToolProgress {
                                        tool: tool.to_string(),
                                        status: v["status"].as_str().unwrap_or("").to_string(),
                                    };
                                }
                            }
                            continue;
                        }
                        Some(_) => continue,
                    }
                    if data == "[DONE]" {
                        finished = true;
                        break 'outer;
                    }
                    if data.is_empty() {
                        continue;
                    }
                    acc.got_data = true;
                    let Ok(v) = serde_json::from_str::<Value>(data) else { continue };
                    match interpret(&v, &mut acc) {
                        Parsed::Delta(t) => yield BrainEvent::Delta(t),
                        Parsed::Error(m) => {
                            yield BrainEvent::Error(m);
                            return;
                        }
                        Parsed::Nothing => {}
                    }
                }
            }
            if !finished && !acc.got_data {
                yield BrainEvent::Error("Hermes closed the stream without a response".into());
                return;
            }
            yield BrainEvent::Done {
                usage: acc.usage.unwrap_or_default(),
                model: acc.model.unwrap_or(model),
            };
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sse_parser_handles_split_chunks_and_crlf() {
        let mut p = SseParser::default();
        assert!(p.feed(b"data: {\"a\"").is_empty());
        let out = p.feed(b":1}\r\n\r\n: keepalive\n\nevent: x\ndata:[DONE]\n");
        assert_eq!(
            out,
            vec![
                (None, "{\"a\":1}".to_string()),
                (Some("x".to_string()), "[DONE]".to_string())
            ]
        );
        // event name resets after the blank line
        assert_eq!(p.feed(b"\ndata: z\n"), vec![(None, "z".to_string())]);
    }

    #[test]
    fn sse_parser_split_utf8() {
        let mut p = SseParser::default();
        let s = "data: héllo\n".as_bytes();
        let (a, b) = s.split_at(8); // splits inside 'é'
        assert!(p.feed(a).is_empty());
        assert_eq!(p.feed(b), vec![(None, "héllo".to_string())]);
    }

    #[test]
    fn interpret_chunks() {
        let mut acc = Acc::default();
        let c = json!({"model":"m1","choices":[{"delta":{"content":"hi"}}]});
        assert!(matches!(interpret(&c, &mut acc), Parsed::Delta(t) if t == "hi"));
        let u = json!({"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":4}});
        assert!(matches!(interpret(&u, &mut acc), Parsed::Nothing));
        assert_eq!(acc.usage.unwrap().completion_tokens, 4);
        assert_eq!(acc.model.as_deref(), Some("m1"));
        let role = json!({"choices":[{"delta":{"role":"assistant"}}]});
        assert!(matches!(interpret(&role, &mut acc), Parsed::Nothing));
        let e = json!({"error":{"message":"boom"}});
        assert!(matches!(interpret(&e, &mut acc), Parsed::Error(m) if m == "boom"));
    }

    #[tokio::test]
    async fn unreachable_yields_error_event() {
        // Port 1 on loopback is closed.
        let b = HermesBrain::new("http://127.0.0.1:1/v1", Some("secret-key".into()), None);
        let evs: Vec<_> = b
            .chat_stream(ChatRequest {
                messages: vec![],
                model: None,
                session_id: None,
            })
            .collect()
            .await;
        assert_eq!(evs.len(), 1);
        match &evs[0] {
            BrainEvent::Error(m) => assert!(!m.contains("secret-key")),
            other => panic!("unexpected {other:?}"),
        }
    }
}
