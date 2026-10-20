# src-tauri - Hermes Workbench desktop shell

Thin Tauri 2 shell around `workbench-core`. It only does what needs the OS: window
(overlay title bar), menu-bar tray (Show / Quit), global shortcut Option+Space, Keychain, and
starting/stopping `workbench-core` in-process on a random `127.0.0.1` port. It injects
`window.__WORKBENCH__ = {baseUrl, token}` before the web app loads.

## Run on the Mac
```sh
pnpm -C web install
pnpm -C web dev                      # terminal 1: Vite on :5173
npm install --prefix src-tauri       # once: installs the Tauri CLI
cd src-tauri && npx tauri dev        # terminal 2 (or `cargo tauri dev` if cargo-tauri is installed)
```
Hermes env vars (`HERMES_URL`, ...) are read from the environment; see docs/architecture.md.
Production build: `cd src-tauri && npx tauri build --target aarch64-apple-darwin` (dmg in
`target/aarch64-apple-darwin/release/bundle/dmg`). CI does this on `macos-14`
(`.github/workflows/macos-build.yml`) with ad-hoc signing; right-click > Open the first time.

## Keychain
Commands `set_hermes_key(key)` / `has_hermes_key()`. The key is read at startup and passed to core
as `hermes_api_key`; changing it needs an app restart. Never logged.

## macOS-only / not buildable on Linux
The whole crate needs WebKit (Linux needs WebKitGTK) and is excluded from default workspace members.
Keychain (`keyring` apple-native) is macOS-gated; other OSes return an error / `false`.
Icons: regenerate from `app-icon.png` with `npm run icons --prefix src-tauri` (delete the android/ios dirs).
