//! Hermes Workbench - thin Tauri shell around `workbench-core`.
//!
//! Responsibilities: window, tray, global shortcut, Keychain, start/stop core in-process,
//! inject `window.__WORKBENCH__ = {baseUrl, token}` before the web app loads.

use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicI32, Ordering},
        Mutex,
    },
};

use tauri::{
    menu::{Menu, MenuItem},
    tray::{TrayIcon, TrayIconBuilder},
    AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tauri_plugin_notification::NotificationExt;

#[cfg(target_os = "macos")]
const KEYCHAIN_SERVICE: &str = "dev.harness.workbench";

/// Holds the running core so it can be shut down on exit.
struct CoreHandle(Mutex<Option<workbench_core::RunningServer>>);

/// Tray icon kept in managed state so `native_set_badge` can update its tooltip/title.
struct TrayHandle(TrayIcon);

/// notification id -> approval id, plus the most recently notified approval (fallback when the
/// plugin's `ActionPerformed` carries no readable notification).
#[derive(Default)]
struct NotifyMap {
    next_id: AtomicI32,
    by_id: Mutex<HashMap<i32, String>>,
    last: Mutex<Option<String>>,
}

/// JS injected into every window (after `window.__WORKBENCH__`). Calls the commands below through
/// `__TAURI_INTERNALS__`; camelCase keys (`approvalId`) map to snake_case Rust params (`approval_id`).
const NATIVE_INIT: &str = r#"
(function () {
  function call(cmd, args) {
    try {
      var t = window.__TAURI_INTERNALS__;
      if (t && typeof t.invoke === 'function') {
        return Promise.resolve(t.invoke(cmd, args)).catch(function () {});
      }
    } catch (e) {}
    return Promise.resolve();
  }
  window.__WORKBENCH_NATIVE__ = {
    notify: function (title, body, approvalId) {
      return call('native_notify', {
        title: String(title == null ? '' : title),
        body: String(body == null ? '' : body),
        approvalId: approvalId == null ? null : String(approvalId)
      });
    },
    setBadge: function (count) {
      return call('native_set_badge', { count: Math.max(0, Math.floor(Number(count) || 0)) });
    }
  };
})();
"#;

// ---------------------------------------------------------------- keychain

/// macOS Keychain-backed secret store handed to core (`Config.secret_store`).
/// Core's PUT /api/settings/hermes is the single path for writing the Hermes key.
/// Values are never logged.
#[cfg(target_os = "macos")]
struct KeychainStore;

#[cfg(target_os = "macos")]
impl workbench_core::SecretStore for KeychainStore {
    fn get(&self, k: &str) -> Option<String> {
        keyring::Entry::new(KEYCHAIN_SERVICE, k)
            .ok()?
            .get_password()
            .ok()
            .filter(|v| !v.is_empty())
    }

    fn set(&self, k: &str, v: &str) -> anyhow::Result<()> {
        let entry = keyring::Entry::new(KEYCHAIN_SERVICE, k)?;
        entry.set_password(v)?;
        Ok(())
    }
}

// ---------------------------------------------------------------- window

fn show_main_window(app: &AppHandle) {
    // Un-hide the app first (it may have been hidden to return focus to the previous app).
    #[cfg(target_os = "macos")]
    let _ = app.show();
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// Show+focus main and ask the web app to focus an approval (explicit user intent).
/// `approval_id` None focuses whichever card the web app picks.
fn open_main_focus_approval(app: &AppHandle, approval_id: Option<&str>) {
    show_main_window(app);
    if let Some(w) = app.get_webview_window("main") {
        let detail = match approval_id {
            Some(id) => serde_json::json!({ "explicit": true, "approvalId": id }),
            None => serde_json::json!({ "explicit": true }),
        };
        let _ = w.eval(format!(
            "window.dispatchEvent(new CustomEvent('workbench:focus-approval', {{detail:{}}}))",
            detail
        ));
    }
}

/// Hide the quick window, tell its webview to reset, and hand focus back to the previously
/// active app (macOS: hide this app, but only when main is not visible so main is not hidden too).
fn hide_quick_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("quick") {
        let was_visible = w.is_visible().unwrap_or(false);
        let _ = w.hide();
        let _ = w.eval("window.dispatchEvent(new Event('workbench:quick-hidden'))");
        #[cfg(target_os = "macos")]
        if was_visible {
            let main_visible = app
                .get_webview_window("main")
                .and_then(|m| m.is_visible().ok())
                .unwrap_or(false);
            if !main_visible {
                let _ = app.hide();
            }
        }
        #[cfg(not(target_os = "macos"))]
        let _ = was_visible;
    }
}

fn toggle_quick_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("quick") {
        if w.is_visible().unwrap_or(false) {
            hide_quick_window(app);
        } else {
            let _ = w.show();
            let _ = w.set_focus();
        }
    }
}

// ---------------------------------------------------------------- commands

#[tauri::command]
fn native_notify(app: AppHandle, title: String, body: String, approval_id: Option<String>) {
    let mut builder = app.notification().builder().title(title).body(body);
    if let (Some(approval), Some(map)) = (approval_id, app.try_state::<NotifyMap>()) {
        let id = map.next_id.fetch_add(1, Ordering::Relaxed).wrapping_add(1).max(1);
        if let Ok(mut m) = map.by_id.lock() {
            if m.len() > 200 {
                m.clear();
            }
            m.insert(id, approval.clone());
        }
        if let Ok(mut l) = map.last.lock() {
            *l = Some(approval);
        }
        builder = builder.id(id);
    }
    if let Err(e) = builder.show() {
        eprintln!("workbench: notification failed: {e}");
    }
}

#[tauri::command]
fn native_set_badge(app: AppHandle, count: u32) {
    if let Some(tray) = app.try_state::<TrayHandle>() {
        let tooltip = if count > 0 {
            format!("Hermes Workbench - {count} pending")
        } else {
            "Hermes Workbench".to_string()
        };
        let _ = tray.0.set_tooltip(Some(tooltip));
        let title = if count > 0 { Some(count.to_string()) } else { None };
        let _ = tray.0.set_title(title);
    }
    // Dock badge (macOS): Window::set_badge_count(Option<i64>); None clears it.
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_badge_count(if count > 0 { Some(count as i64) } else { None });
    }
}

#[tauri::command]
fn open_main(app: AppHandle, focus_approval: bool, approval_id: Option<String>) {
    if focus_approval {
        open_main_focus_approval(&app, approval_id.as_deref());
    } else {
        show_main_window(&app);
    }
}

#[tauri::command]
fn hide_quick(app: AppHandle) {
    hide_quick_window(&app);
}

// ---------------------------------------------------------------- entry

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            native_notify,
            native_set_badge,
            open_main,
            hide_quick
        ])
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        toggle_quick_window(app);
                    }
                })
                .build(),
        )
        .on_window_event(|window, event| {
            // macOS convention: closing the window hides it to the tray; Quit (tray / Cmd+Q) exits.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
            // The quick window is a transient popover: hide it when it loses focus.
            if let tauri::WindowEvent::Focused(false) = event {
                if window.label() == "quick" {
                    hide_quick_window(window.app_handle());
                }
            }
        })
        .setup(|app| {
            // --- start core in-process. Keep core's default data dir (~/Library/Application Support/Workbench,
            // or WORKBENCH_DATA_DIR) so the app and a standalone `workbench-core` share tokens and the database.
            let mut config = workbench_core::Config::from_env()?;
            std::fs::create_dir_all(&config.data_dir)?;
            // Keychain only on macOS; elsewhere keys stay memory-only.
            #[cfg(target_os = "macos")]
            {
                config.secret_store = Some(std::sync::Arc::new(KeychainStore));
            }
            // Stable address 127.0.0.1:8765 (what the Hermes profile points at); if busy,
            // fall back to a random port and flag it so the UI can warn.
            config.addr = "127.0.0.1:8765".parse()?;
            let server = match tauri::async_runtime::block_on(workbench_core::serve(config.clone()))
            {
                Ok(s) => s,
                Err(e) => {
                    eprintln!("workbench: 127.0.0.1:8765 unavailable ({e}); using a random port");
                    config.addr = "127.0.0.1:0".parse()?;
                    config.addr_fallback = true;
                    tauri::async_runtime::block_on(workbench_core::serve(config))?
                }
            };
            let base_url = format!("http://{}", server.addr);
            let init = format!(
                "window.__WORKBENCH__ = {};\n{}",
                serde_json::json!({ "baseUrl": base_url, "token": server.token }),
                NATIVE_INIT
            );
            app.manage(NotifyMap::default());
            app.manage(CoreHandle(Mutex::new(Some(server))));

            // --- main window, created programmatically so the init script runs before the app
            let builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
                .title("Hermes Workbench")
                .inner_size(1280.0, 820.0)
                .min_inner_size(900.0, 600.0)
                .initialization_script(&init);
            #[cfg(target_os = "macos")]
            let builder = builder
                .title_bar_style(tauri::TitleBarStyle::Overlay)
                .hidden_title(true);
            builder.build()?;

            // --- quick window (hidden; toggled by Option+Space, hides on blur)
            WebviewWindowBuilder::new(app, "quick", WebviewUrl::App("index.html#/quick".into()))
                .title("Quick")
                .inner_size(640.0, 360.0)
                .decorations(false)
                .always_on_top(true)
                .skip_taskbar(true)
                .visible(false)
                .visible_on_all_workspaces(true)
                .center()
                .initialization_script(&init)
                .build()?;

            // --- notification click (macOS: notify-rust wait_for_response -> `tap`) opens main on the
            // approval. Registered before any notification is shown (the plugin only tracks
            // clicks for notifications shown after a handler exists).
            {
                let handle = app.handle().clone();
                app.notification().on_action(move |performed| {
                    if performed.action_id() == "tap" {
                        let approval = handle.try_state::<NotifyMap>().and_then(|map| {
                            performed
                                .notification()
                                .and_then(|n| map.by_id.lock().ok()?.get(&n.id()).cloned())
                                .or_else(|| map.last.lock().ok()?.clone())
                        });
                        open_main_focus_approval(&handle, approval.as_deref());
                    }
                })?;
            }

            // --- tray / menu-bar icon
            let show = MenuItem::with_id(app, "show", "Show Workbench", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            let mut tray = TrayIconBuilder::new()
                .menu(&menu)
                .tooltip("Hermes Workbench")
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => show_main_window(app),
                    "quit" => app.exit(0),
                    _ => {}
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            let tray_icon = tray.build(app)?;
            app.manage(TrayHandle(tray_icon));

            // --- global shortcut (Option+Space). Failure (taken by another app) is non-fatal.
            if let Err(e) = app.global_shortcut().register("alt+space") {
                eprintln!("workbench: could not register Alt+Space: {e}");
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Hermes Workbench");

    app.run(|app, event| {
        #[cfg(target_os = "macos")]
        if let RunEvent::Reopen { .. } = event {
            show_main_window(app);
            return;
        }
        if let RunEvent::Exit = event {
            if let Some(state) = app.try_state::<CoreHandle>() {
                if let Some(server) = state.0.lock().ok().and_then(|mut g| g.take()) {
                    tauri::async_runtime::block_on(server.shutdown());
                }
            }
        }
    });
}
