//! Hermes Workbench core: objects, tools, the approval gate and an MCP server.
//!
//! See `docs/architecture.md` for the contract.

pub mod api;
pub mod approvals;
pub mod brain;
pub mod config;
pub mod db;
pub mod error;
pub mod events;
pub mod journal;
pub mod ledger;
pub mod mcp;
pub mod objects;
pub mod policy;
pub mod secrets;
pub mod state;
pub mod tools;

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use anyhow::Context;
use rand::RngCore;
use tokio::sync::{oneshot, watch};
use tokio::task::JoinHandle;

pub use config::Config;
pub use secrets::SecretStore;

pub struct RunningServer {
    pub addr: std::net::SocketAddr,
    /// UI token (`/api/*` only).
    pub token: String,
    /// MCP token (`/mcp` only).
    pub mcp_token: String,
    shutdown_flag: watch::Sender<bool>,
    shutdown_tx: oneshot::Sender<()>,
    join: JoinHandle<()>,
}

impl RunningServer {
    /// Stop accepting connections, end SSE streams and wait (briefly) for exit.
    pub async fn shutdown(self) {
        let _ = self.shutdown_flag.send(true);
        let _ = self.shutdown_tx.send(());
        let mut join = self.join;
        if tokio::time::timeout(Duration::from_secs(3), &mut join)
            .await
            .is_err()
        {
            join.abort();
        }
    }
}

/// Explicit value wins (not written); else reuse the persisted file; else generate + persist.
fn resolve_token(explicit: Option<String>, path: &Path) -> anyhow::Result<String> {
    if let Some(t) = explicit {
        return Ok(t);
    }
    if let Ok(existing) = std::fs::read_to_string(path) {
        let t = existing.trim();
        if !t.is_empty() {
            return Ok(t.to_string());
        }
    }
    let t = generate_token();
    write_token_file(path, &t)?;
    Ok(t)
}

fn generate_token() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    hex::encode(bytes)
}

/// Write the token to `path` readable only by the current user.
fn write_token_file(path: &Path, token: &str) -> anyhow::Result<()> {
    use std::io::Write;
    #[cfg(unix)]
    {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)?;
        f.write_all(token.as_bytes())?;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    #[cfg(not(unix))]
    {
        let mut f = std::fs::File::create(path)?;
        f.write_all(token.as_bytes())?;
    }
    Ok(())
}

/// Bind, start serving in the background and return a handle.
pub async fn serve(config: Config) -> anyhow::Result<RunningServer> {
    config::check_bind(&config.addr, config::allow_remote_from_env())?;
    std::fs::create_dir_all(&config.data_dir)
        .with_context(|| format!("creating data dir {}", config.data_dir.display()))?;

    let token = resolve_token(config.token.clone(), &config.data_dir.join("token"))?;
    let mcp_token = resolve_token(config.mcp_token.clone(), &config.data_dir.join("mcp_token"))?;

    let db = db::Db::open(&config.data_dir.join("workbench.db")).context("opening database")?;
    let events = events::Events::new();
    let approvals = approvals::Approvals::new(db.clone(), events.clone());
    approvals
        .expire_stale()
        .map_err(|e| anyhow::anyhow!("{e}"))?;

    let hermes_model = std::env::var("HERMES_MODEL")
        .ok()
        .filter(|m| !m.trim().is_empty());
    // A URL the user saved in Settings wins over the configured default.
    let saved_url = db
        .with(|c| db::get_setting(c, "hermes"))
        .ok()
        .flatten()
        .and_then(|v| v["url"].as_str().map(String::from));
    let hermes = state::HermesRuntime {
        url: saved_url.unwrap_or_else(|| config.hermes_url.clone()),
        api_key: config.hermes_api_key.clone().or_else(|| {
            config
                .secret_store
                .as_ref()
                .and_then(|s| s.get(secrets::HERMES_API_KEY))
                .filter(|k| !k.is_empty())
        }),
    };
    let brain: Arc<dyn brain::Brain> = Arc::new(brain::HermesBrain::new(
        &hermes.url,
        hermes.api_key.clone(),
        hermes_model.clone(),
    ));

    let listener = tokio::net::TcpListener::bind(config.addr)
        .await
        .with_context(|| format!("binding {}", config.addr))?;
    let addr = listener.local_addr()?;

    let (flag_tx, flag_rx) = watch::channel(false);
    let state = Arc::new(state::AppState {
        db,
        events,
        approvals,
        config,
        token: token.clone(),
        mcp_token: mcp_token.clone(),
        addr,
        brain: std::sync::RwLock::new(brain),
        hermes: std::sync::RwLock::new(hermes),
        hermes_model,
        http: reqwest::Client::new(),
        shutdown: flag_rx,
    });
    let app = api::router(state);

    let (tx, rx) = oneshot::channel::<()>();
    let join = tokio::spawn(async move {
        let res = axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                let _ = rx.await;
            })
            .await;
        if let Err(e) = res {
            tracing::error!("server error: {e}");
        }
    });

    Ok(RunningServer {
        addr,
        token,
        mcp_token,
        shutdown_flag: flag_tx,
        shutdown_tx: tx,
        join,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_are_random_hex() {
        let (a, b) = (generate_token(), generate_token());
        assert_eq!(a.len(), 64);
        assert_ne!(a, b);
    }

    #[cfg(unix)]
    #[test]
    fn token_file_is_private() {
        use std::os::unix::fs::PermissionsExt;
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("token");
        write_token_file(&p, "abc").unwrap();
        write_token_file(&p, "def").unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "def");
        assert_eq!(
            std::fs::metadata(&p).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}
