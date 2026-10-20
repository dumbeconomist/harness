# Hermes Workbench

Hermes Workbench is a Mac workspace for doing work *with* AI, not just asking it questions. Hermes
Agent is the brain. Workbench owns the objects (tasks, goals, docs), the tools the AI can call, and
the approval gate: nothing the AI writes or sends happens without a human decision, and every change
is journaled so it can be undone where the tool supports it.

## Architecture

```
 ┌───────────── Tauri shell (macOS only, thin) ─────────────┐
 │  window · menu bar · ⌥Space · Keychain · spawns core     │
 │  injects window.__WORKBENCH__ = {baseUrl, token}         │
 └───────────────┬──────────────────────────────────────────┘
                 │ HTTP + SSE (127.0.0.1:8765, bearer token)
 ┌───────────────▼──────────── workbench-core (Rust) ───────┐
 │ /api/*  app API for the React UI                         │
 │ /mcp    MCP server (JSON-RPC, streamable HTTP) ◄── Hermes│
 │ approvals · journal(undo, idempotency) · ledger · objects│
 │ brain: OpenAI-compatible client ──► Hermes :8642         │
 │ SQLite: $WORKBENCH_DATA_DIR/workbench.db                 │
 └──────────────────────────────────────────────────────────┘
```

Full contracts (API, MCP tools, risk tiers, data model) are in [docs/architecture.md](docs/architecture.md).

| Path | What |
|---|---|
| `core/` | Rust crate `workbench-core` (library and binary) |
| `src-tauri/` | Tauri 2 shell, built on macOS only |
| `web/` | React 18 + TypeScript + Vite app |
| `tools/mock-hermes/` | Node mock of Hermes' OpenAI-compatible API |
| `e2e/` | Playwright tests |
| `docs/` | Architecture, rubric, scorecard |

## Quickstart (macOS dev)

1. **Enable the Hermes API server.** Add these to `~/.hermes/.env`, then start the gateway:

   ```sh
   API_SERVER_ENABLED=true
   API_SERVER_KEY=<a-long-random-string>
   ```

   ```sh
   hermes gateway
   ```

2. **Run the core** (terminal 1):

   ```sh
   cargo run -p workbench-core
   ```

3. **Run the web UI** (terminal 2):

   ```sh
   pnpm -C web dev
   ```

   Or run the whole desktop app, shell included, with `cargo tauri dev`.

No Hermes yet? Run `node tools/mock-hermes/server.js` in place of the gateway. It listens on the
same port (8642) that the core expects by default.

## Testing

```sh
cargo test -p workbench-core     # core unit and integration tests
pnpm -C web test                 # web unit tests (vitest)
node --test tools/mock-hermes/server.test.js   # mock Hermes tests
# e2e: Playwright tests in e2e/ (core + mock-hermes + built web app)
```

Quality gates and scoring: [docs/rubric.md](docs/rubric.md). Milestone results:
[docs/scorecard.md](docs/scorecard.md).

## Milestones

| Milestone | Scope |
|---|---|
| G0 | Foundation & Hermes spike |
| G1 | Shell & command surface |
| G2 | Tasks, Goals & Routines |
| G3 | Docs & writing |
| G4 | Email & CRM |
| G5 | Research |
| G6 | Code & repos |
| G7 | Hardening |

Each milestone must pass the rubric gate, then a human sign-off on the macOS build, before the next
one starts.
