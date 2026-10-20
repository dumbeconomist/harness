//! Hermes Workbench - thin Tauri shell around `workbench-core`.
//!
//! Responsibilities: window, tray, global shortcut, Keychain, start/stop core in-process,
//! inject `window.__WORKBENCH__ = {baseUrl, token}` before the web app loads.

use std::sync::Mutex;

use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

#[cfg(target_os = "macos")]
const KEYCHAIN_SERVICE: &str = "dev.harness.workbench";

/// Holds the running core so it can be shut down on exit.
struct CoreHandle(Mutex<Option<workbench_core::RunningServer>>);

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
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn open_palette(app: &AppHandle) {
    show_main_window(app);
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.eval("window.dispatchEvent(new CustomEvent('workbench:palette'))");
    }
}

// ---------------------------------------------------------------- entry

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        open_palette(app);
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
                "window.__WORKBENCH__ = {};",
                serde_json::json!({ "baseUrl": base_url, "token": server.token })
            );
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
            tray.build(app)?;

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
