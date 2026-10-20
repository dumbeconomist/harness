//! In-process event bus feeding `GET /api/events` (SSE).

use serde::Serialize;
use serde_json::Value;
use tokio::sync::broadcast;

#[derive(Clone, Debug, Serialize)]
pub struct Event {
    #[serde(rename = "type")]
    pub kind: String,
    pub payload: Value,
}

#[derive(Clone)]
pub struct Events {
    tx: broadcast::Sender<Event>,
}

impl Default for Events {
    fn default() -> Self {
        Self::new()
    }
}

impl Events {
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel(256);
        Self { tx }
    }

    pub fn emit(&self, kind: &str, payload: Value) {
        // No subscribers is fine.
        let _ = self.tx.send(Event {
            kind: kind.to_string(),
            payload,
        });
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Event> {
        self.tx.subscribe()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn delivers_to_subscribers() {
        let ev = Events::new();
        ev.emit("lost", Value::Null); // no subscriber, must not panic
        let mut rx = ev.subscribe();
        ev.emit("task.changed", serde_json::json!({"id": "1"}));
        let got = rx.recv().await.unwrap();
        assert_eq!(got.kind, "task.changed");
        let s = serde_json::to_value(&got).unwrap();
        assert_eq!(s["type"], "task.changed");
        assert_eq!(s["payload"]["id"], "1");
    }
}
