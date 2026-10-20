//! Shared application state.

use std::sync::Arc;

use tokio::sync::watch;

use crate::approvals::Approvals;
use crate::brain::Brain;
use crate::config::Config;
use crate::db::Db;
use crate::events::Events;

pub struct AppState {
    pub db: Db,
    pub events: Events,
    pub approvals: Arc<Approvals>,
    pub config: Config,
    pub token: String,
    pub brain: Arc<dyn Brain>,
    pub http: reqwest::Client,
    /// Flips to `true` on shutdown so long-lived SSE streams can end.
    pub shutdown: watch::Receiver<bool>,
}

pub type SharedState = Arc<AppState>;
