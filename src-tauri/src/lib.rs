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

const KEYCHAIN_SERVICE: &str = "dev.harness.workbench";
const KEYCHAIN_ACCOUNT: &str = "hermes-api-key";

/// Holds the running core so it can be shut down on exit.
struct CoreHandle(Mutex<Option<workbench_core::RunningServer>>);

// ---------------------------------------------------------------- keychain

#[cfg(target_os = "macos")]
fn keychain_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT).map_err(|e| e.to_string())
}

#[cfg(target_os = "macos")]
fn read_hermes_key() -> Option<String> {
    keychain_entry()
        .ok()?
        .get_password()
        .ok()
        .filter(|k| !k.is_empty())
}

#[cfg(not(target_os = "macos"))]
fn read_hermes_key() -> Option<String> {
    None
}

/// Store the Hermes API key in the macOS Keychain. Takes effect on next app start.
#[tauri::command]
fn set_hermes_key(key: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let entry = keychain_entry()?;
        if key.is_empty() {
            // Clearing: ignore "no entry" errors.
            let _ = entry.delete_credential();
            return Ok(());
        }
        entry.set_password(&key).map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = key;
        Err("Keychain is only available on macOS".into())
    }
}

#[tauri::command]
fn has_hermes_key() -> bool {
    read_hermes_key().is_some()
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
        .invoke_handler(tauri::generate_handler![set_hermes_key, has_hermes_key])
        .setup(|app| {
            // --- start core in-process on a random loopback port
            let mut config = workbench_core::Config::from_env()?;
            config.addr = "127.0.0.1:0".parse()?;
            config.data_dir = app.path().app_data_dir()?;
            if let Some(key) = read_hermes_key() {
                config.hermes_api_key = Some(key);
            }
            std::fs::create_dir_all(&config.data_dir)?;
            let server = tauri::async_runtime::block_on(workbench_core::serve(config))?;
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
        if let RunEvent::Exit = event {
            if let Some(state) = app.try_state::<CoreHandle>() {
                if let Some(server) = state.0.lock().ok().and_then(|mut g| g.take()) {
                    tauri::async_runtime::block_on(server.shutdown());
                }
            }
        }
    });
}
