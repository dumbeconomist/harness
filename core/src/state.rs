//! Shared application state.

use std::net::SocketAddr;
use std::sync::{Arc, RwLock};

use tokio::sync::watch;

use crate::approvals::Approvals;
use crate::brain::Brain;
use crate::config::Config;
use crate::db::Db;
use crate::events::Events;

/// Live Hermes connection settings (hot-swappable).
#[derive(Clone)]
pub struct HermesRuntime {
    pub url: String,
    pub api_key: Option<String>,
}

pub struct AppState {
    pub db: Db,
    pub events: Events,
    pub approvals: Arc<Approvals>,
    pub config: Config,
    /// UI token (`/api/*`).
    pub token: String,
    /// MCP token (`/mcp`).
    pub mcp_token: String,
    /// Address actually bound.
    pub addr: SocketAddr,
    pub brain: RwLock<Arc<dyn Brain>>,
    pub hermes: RwLock<HermesRuntime>,
    pub hermes_model: Option<String>,
    /// Idempotency key -> id of the approval currently awaiting a decision, so
    /// concurrent identical calls share one card.
    pub inflight: std::sync::Mutex<std::collections::HashMap<String, String>>,
    pub http: reqwest::Client,
    /// Flips to `true` on shutdown so long-lived SSE streams can end.
    pub shutdown: watch::Receiver<bool>,
}

impl AppState {
    pub fn brain(&self) -> Arc<dyn Brain> {
        self.brain.read().unwrap_or_else(|e| e.into_inner()).clone()
    }
    pub fn hermes(&self) -> HermesRuntime {
        self.hermes
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }
    pub fn mcp_url(&self) -> String {
        format!("http://{}/mcp", self.addr)
    }
}

pub type SharedState = Arc<AppState>;
