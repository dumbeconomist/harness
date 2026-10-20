//! Secret storage abstraction (the Tauri shell provides a Keychain impl).

use std::collections::HashMap;
use std::sync::Mutex;

pub trait SecretStore: Send + Sync {
    fn get(&self, key: &str) -> Option<String>;
    fn set(&self, key: &str, value: &str) -> anyhow::Result<()>;
}

/// Key under which the Hermes API key is stored.
pub const HERMES_API_KEY: &str = "hermes_api_key";

/// In-memory store, handy for tests and headless runs.
#[derive(Default)]
pub struct MemorySecretStore(Mutex<HashMap<String, String>>);

impl SecretStore for MemorySecretStore {
    fn get(&self, key: &str) -> Option<String> {
        self.0.lock().ok()?.get(key).cloned()
    }
    fn set(&self, key: &str, value: &str) -> anyhow::Result<()> {
        self.0
            .lock()
            .map_err(|_| anyhow::anyhow!("poisoned"))?
            .insert(key.into(), value.into());
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_store_roundtrip() {
        let s = MemorySecretStore::default();
        assert!(s.get("a").is_none());
        s.set("a", "b").unwrap();
        assert_eq!(s.get("a").as_deref(), Some("b"));
    }
}
