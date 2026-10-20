//! Runtime configuration.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::time::Duration;

use anyhow::{anyhow, Context};

#[derive(Clone)]
pub struct Config {
    pub addr: SocketAddr,
    pub token: Option<String>,
    pub data_dir: PathBuf,
    pub hermes_url: String,
    pub hermes_api_key: Option<String>,
    pub approval_timeout: Duration,
}

// Never print secrets.
impl std::fmt::Debug for Config {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Config")
            .field("addr", &self.addr)
            .field("token", &self.token.as_ref().map(|_| "<redacted>"))
            .field("data_dir", &self.data_dir)
            .field("hermes_url", &self.hermes_url)
            .field(
                "hermes_api_key",
                &self.hermes_api_key.as_ref().map(|_| "<redacted>"),
            )
            .field("approval_timeout", &self.approval_timeout)
            .finish()
    }
}

pub const DEFAULT_ADDR: &str = "127.0.0.1:8765";
pub const DEFAULT_HERMES_URL: &str = "http://127.0.0.1:8642/v1";
pub const DEFAULT_APPROVAL_TIMEOUT_SECS: u64 = 300;

fn default_data_dir(home: Option<String>) -> PathBuf {
    let home = PathBuf::from(home.unwrap_or_else(|| ".".into()));
    if cfg!(target_os = "macos") {
        home.join("Library/Application Support/Workbench")
    } else {
        home.join(".local/share/workbench")
    }
}

impl Config {
    pub fn from_env() -> anyhow::Result<Config> {
        Self::from_lookup(|k| std::env::var(k).ok())
    }

    /// Build a config from any key lookup (testable without touching the process env).
    pub fn from_lookup(get: impl Fn(&str) -> Option<String>) -> anyhow::Result<Config> {
        let nonempty = |k: &str| get(k).filter(|v| !v.trim().is_empty());
        let addr_s = nonempty("WORKBENCH_ADDR").unwrap_or_else(|| DEFAULT_ADDR.into());
        let addr: SocketAddr = addr_s
            .parse()
            .with_context(|| format!("invalid WORKBENCH_ADDR '{addr_s}'"))?;
        let timeout = match nonempty("WORKBENCH_APPROVAL_TIMEOUT_SECS") {
            Some(s) => s
                .trim()
                .parse::<u64>()
                .map_err(|_| anyhow!("invalid WORKBENCH_APPROVAL_TIMEOUT_SECS '{s}'"))?,
            None => DEFAULT_APPROVAL_TIMEOUT_SECS,
        };
        Ok(Config {
            addr,
            token: nonempty("WORKBENCH_TOKEN"),
            data_dir: nonempty("WORKBENCH_DATA_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|| default_data_dir(get("HOME"))),
            hermes_url: nonempty("HERMES_URL").unwrap_or_else(|| DEFAULT_HERMES_URL.into()),
            hermes_api_key: nonempty("HERMES_API_KEY"),
            approval_timeout: Duration::from_secs(timeout),
        })
    }
}

/// Refuse non-loopback binds unless explicitly allowed.
pub fn check_bind(addr: &SocketAddr, allow_remote: bool) -> anyhow::Result<()> {
    if addr.ip().is_loopback() || allow_remote {
        Ok(())
    } else {
        Err(anyhow!(
            "refusing to bind non-loopback address {addr}; set WORKBENCH_ALLOW_REMOTE=1 to override"
        ))
    }
}

pub fn allow_remote_from_env() -> bool {
    std::env::var("WORKBENCH_ALLOW_REMOTE")
        .map(|v| v == "1")
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn lookup(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let m: HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        move |k| m.get(k).cloned()
    }

    #[test]
    fn defaults() {
        let c = Config::from_lookup(lookup(&[("HOME", "/h")])).unwrap();
        assert_eq!(c.addr.to_string(), DEFAULT_ADDR);
        assert_eq!(c.hermes_url, DEFAULT_HERMES_URL);
        assert_eq!(c.approval_timeout, Duration::from_secs(300));
        assert!(c.token.is_none() && c.hermes_api_key.is_none());
        assert!(c.data_dir.starts_with("/h"));
    }

    #[test]
    fn overrides_and_errors() {
        let c = Config::from_lookup(lookup(&[
            ("WORKBENCH_ADDR", "127.0.0.1:0"),
            ("WORKBENCH_TOKEN", "t"),
            ("WORKBENCH_DATA_DIR", "/d"),
            ("HERMES_URL", "http://x/v1"),
            ("HERMES_API_KEY", "k"),
            ("WORKBENCH_APPROVAL_TIMEOUT_SECS", "1"),
        ]))
        .unwrap();
        assert_eq!(c.addr.port(), 0);
        assert_eq!(c.token.as_deref(), Some("t"));
        assert_eq!(c.data_dir, PathBuf::from("/d"));
        assert_eq!(c.approval_timeout, Duration::from_secs(1));
        assert!(Config::from_lookup(lookup(&[("WORKBENCH_ADDR", "nope")])).is_err());
        assert!(Config::from_lookup(lookup(&[("WORKBENCH_APPROVAL_TIMEOUT_SECS", "x")])).is_err());
    }

    #[test]
    fn debug_redacts_secrets() {
        let c = Config::from_lookup(lookup(&[
            ("WORKBENCH_TOKEN", "supersecret"),
            ("HERMES_API_KEY", "keysecret"),
        ]))
        .unwrap();
        let d = format!("{c:?}");
        assert!(!d.contains("supersecret") && !d.contains("keysecret"));
    }

    #[test]
    fn bind_policy() {
        let lo: SocketAddr = "127.0.0.1:1".parse().unwrap();
        let lo6: SocketAddr = "[::1]:1".parse().unwrap();
        let any: SocketAddr = "0.0.0.0:1".parse().unwrap();
        assert!(check_bind(&lo, false).is_ok());
        assert!(check_bind(&lo6, false).is_ok());
        assert!(check_bind(&any, false).is_err());
        assert!(check_bind(&any, true).is_ok());
    }
}
