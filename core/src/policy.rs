//! Risk tiers, per-tool approval policy and permission switches.

use rusqlite::Connection;
use serde_json::{json, Map, Value};

use crate::db::{get_setting, set_setting};
use crate::error::{ApiError, ApiResult};

pub struct ToolDef {
    pub name: &'static str,
    pub tier: u8,
    pub description: &'static str,
    /// Permission switch that must be ON before the tool may run (tier 3 style).
    pub switch: Option<&'static str>,
}

pub const TOOLS: &[ToolDef] = &[
    ToolDef {
        name: "tasks_list",
        tier: 0,
        description: "List tasks, optionally filtered by status (todo, doing, blocked, done). Read-only.",
        switch: None,
    },
    ToolDef {
        name: "tasks_create",
        tier: 1,
        description: "Create a task. Requires user approval unless the user set this tool to auto. Pass idempotency_key to make retries safe.",
        switch: None,
    },
    ToolDef {
        name: "tasks_update",
        tier: 1,
        description: "Update a task's title, notes or status. Requires user approval unless the user set this tool to auto.",
        switch: None,
    },
    ToolDef {
        name: "tasks_delete",
        tier: 2,
        description: "Delete a task. Destructive: always requires user approval.",
        switch: None,
    },
];

pub const SWITCHES: [&str; 6] = ["web", "files", "mail", "terminal", "calendar", "code"];

pub fn tool(name: &str) -> Option<&'static ToolDef> {
    TOOLS.iter().find(|t| t.name == name)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Policy {
    Ask,
    Auto,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Gate {
    Run,
    Ask,
}

/// Tier 0 always runs; tier 1 runs when policy is auto; everything else asks.
pub fn gate(tier: u8, policy: Policy) -> Gate {
    match (tier, policy) {
        (0, _) => Gate::Run,
        (1, Policy::Auto) => Gate::Run,
        _ => Gate::Ask,
    }
}

pub fn get_permissions(conn: &Connection) -> ApiResult<Map<String, Value>> {
    let stored = get_setting(conn, "permissions")?;
    let mut out = Map::new();
    for s in SWITCHES {
        let on = stored
            .as_ref()
            .and_then(|v| v.get(s))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        out.insert(s.to_string(), Value::Bool(on));
    }
    Ok(out)
}

pub fn set_permissions(conn: &Connection, body: &Value) -> ApiResult<Map<String, Value>> {
    let obj = body
        .as_object()
        .ok_or_else(|| ApiError::bad_request("expected a JSON object"))?;
    let mut out = Map::new();
    for s in SWITCHES {
        out.insert(s.to_string(), Value::Bool(false));
    }
    for (k, v) in obj {
        if !SWITCHES.contains(&k.as_str()) {
            return Err(ApiError::bad_request(format!("unknown permission '{k}'")));
        }
        let b = v
            .as_bool()
            .ok_or_else(|| ApiError::bad_request(format!("permission '{k}' must be a boolean")))?;
        out.insert(k.clone(), Value::Bool(b));
    }
    set_setting(conn, "permissions", &Value::Object(out.clone()))?;
    Ok(out)
}

pub fn switch_enabled(conn: &Connection, switch: &str) -> ApiResult<bool> {
    Ok(get_permissions(conn)?
        .get(switch)
        .and_then(Value::as_bool)
        .unwrap_or(false))
}

/// Effective policy for every tier >= 1 tool (default `ask`).
pub fn get_policies(conn: &Connection) -> ApiResult<Map<String, Value>> {
    let stored = get_setting(conn, "policies")?;
    let mut out = Map::new();
    for t in TOOLS.iter().filter(|t| t.tier >= 1) {
        let p = stored
            .as_ref()
            .and_then(|v| v.get(t.name))
            .and_then(Value::as_str)
            .filter(|p| *p == "auto" && t.tier == 1)
            .unwrap_or("ask");
        out.insert(t.name.to_string(), json!(p));
    }
    Ok(out)
}

pub fn set_policies(conn: &Connection, body: &Value) -> ApiResult<Map<String, Value>> {
    let obj = body
        .as_object()
        .ok_or_else(|| ApiError::bad_request("expected a JSON object"))?;
    let mut out = Map::new();
    for t in TOOLS.iter().filter(|t| t.tier >= 1) {
        out.insert(t.name.to_string(), json!("ask"));
    }
    for (name, v) in obj {
        let def = tool(name).filter(|t| t.tier >= 1).ok_or_else(|| {
            ApiError::bad_request(format!("unknown or non-writing tool '{name}'"))
        })?;
        match v.as_str() {
            Some("ask") => {}
            Some("auto") => {
                if def.tier >= 2 {
                    return Err(ApiError::bad_request(format!(
                        "tool '{name}' is tier {} and cannot be set to auto",
                        def.tier
                    )));
                }
                out.insert(name.clone(), json!("auto"));
            }
            _ => {
                return Err(ApiError::bad_request(format!(
                    "policy for '{name}' must be \"ask\" or \"auto\""
                )))
            }
        }
    }
    set_setting(conn, "policies", &Value::Object(out.clone()))?;
    Ok(out)
}

pub fn effective_policy(conn: &Connection, tool_name: &str) -> ApiResult<Policy> {
    let p = get_policies(conn)?;
    Ok(match p.get(tool_name).and_then(Value::as_str) {
        Some("auto") => Policy::Auto,
        _ => Policy::Ask,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;

    #[test]
    fn gate_rules() {
        assert_eq!(gate(0, Policy::Ask), Gate::Run);
        assert_eq!(gate(1, Policy::Ask), Gate::Ask);
        assert_eq!(gate(1, Policy::Auto), Gate::Run);
        assert_eq!(gate(2, Policy::Auto), Gate::Ask);
        assert_eq!(gate(3, Policy::Auto), Gate::Ask);
    }

    #[test]
    fn permissions_default_false_and_roundtrip() {
        let db = Db::open_memory().unwrap();
        let c = db.lock();
        let p = get_permissions(&c).unwrap();
        assert_eq!(p.len(), 6);
        assert!(p.values().all(|v| v == &Value::Bool(false)));
        let p = set_permissions(&c, &json!({"web": true})).unwrap();
        assert_eq!(p["web"], true);
        assert!(switch_enabled(&c, "web").unwrap());
        assert!(!switch_enabled(&c, "files").unwrap());
        assert!(set_permissions(&c, &json!({"bogus": true})).is_err());
        assert!(set_permissions(&c, &json!({"web": "yes"})).is_err());
        assert!(set_permissions(&c, &json!([])).is_err());
    }

    #[test]
    fn policies_default_ask_and_tier2_rejected() {
        let db = Db::open_memory().unwrap();
        let c = db.lock();
        let p = get_policies(&c).unwrap();
        assert_eq!(p["tasks_create"], "ask");
        assert_eq!(p["tasks_delete"], "ask");
        assert!(!p.contains_key("tasks_list"));
        let p = set_policies(&c, &json!({"tasks_create": "auto"})).unwrap();
        assert_eq!(p["tasks_create"], "auto");
        assert_eq!(effective_policy(&c, "tasks_create").unwrap(), Policy::Auto);
        assert_eq!(effective_policy(&c, "tasks_update").unwrap(), Policy::Ask);
        let e = set_policies(&c, &json!({"tasks_delete": "auto"})).unwrap_err();
        assert_eq!(e.status, 400);
        assert!(set_policies(&c, &json!({"nope": "ask"})).is_err());
        assert!(set_policies(&c, &json!({"tasks_create": "maybe"})).is_err());
        // failed PUT did not change anything
        assert_eq!(get_policies(&c).unwrap()["tasks_create"], "auto");
    }

    #[test]
    fn registry() {
        assert_eq!(tool("tasks_delete").unwrap().tier, 2);
        assert!(tool("x").is_none());
    }
}
