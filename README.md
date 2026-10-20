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
 │ brain: OpenAI-compatible client ──► Hermes :8643 (locked profile) │
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

## Quickstart (macOS)

Workbench talks to a **dedicated, locked Hermes profile** (`workbench`, port 8643). In that profile
Hermes's own terminal, file-write, code, browser and scheduling tools are switched off, so every action
goes through Workbench's approval gate. Your normal `~/.hermes` profile is left untouched.
Background and evidence: [`docs/hermes-integration.md` §9](docs/hermes-integration.md).

**Prerequisites:** [Hermes Agent](https://hermes-agent.nousresearch.com/docs) with the `mcp` and
`messaging` extras, plus Rust (stable) and Node 22 with pnpm if you build from source.

1. **Create the locked profile** (idempotent: it never overwrites an existing config or key):

   ```sh
   tools/hermes-spike/workbench-profile/setup-profile.sh
   hermes -p workbench model          # choose the LLM for this profile
   ```

2. **Start Workbench.** Either open the app (the `.dmg` from the `macos-build` CI run; it is ad-hoc
   signed, so right-click → Open the first time), or run the core directly:

   ```sh
   cargo run -p workbench-core        # serves 127.0.0.1:8765
   ```

   On first start Workbench writes two tokens to `~/Library/Application Support/Workbench/`:
   `token` (for the UI, `/api` only) and `mcp_token` (for Hermes, `/mcp` only).

3. **Connect Hermes to Workbench.** Give the profile Workbench's MCP-only token. Re-running the
   setup script is safe; it only fills in keys that are missing:

   ```sh
   WORKBENCH_MCP_TOKEN="$(cat ~/Library/Application\ Support/Workbench/mcp_token)" \
     tools/hermes-spike/workbench-profile/setup-profile.sh
   ```

   **Settings → Connection** in Workbench shows the same token and a ready-made `mcp_servers` snippet.
   The profile's `config.yaml` already contains that entry (reading `${WORKBENCH_MCP_TOKEN}`), so only
   the token needs copying.

4. **Start the locked Hermes gateway**, then point Workbench at it:

   ```sh
   hermes -p workbench gateway run    # API server on 127.0.0.1:8643
   ```

   In **Settings → Hermes**, set the URL to `http://127.0.0.1:8643/v1` (the default) and paste the
   `API_SERVER_KEY` from `~/.hermes/profiles/workbench/.env`. In the app it is stored in the Keychain.

5. **Try it:** select a task, then in the Hermes pane type *"add a task to buy milk"*. An approval card
   appears; approve it, then undo it from **Activity**.

### Web UI dev loop (without the app shell)

```sh
cargo run -p workbench-core
VITE_WORKBENCH_URL=http://127.0.0.1:8765 \
VITE_WORKBENCH_TOKEN=$(cat ~/Library/Application\ Support/Workbench/token) \
pnpm -C web dev
```

No Hermes yet? Run the mock in place of the gateway. With the two MCP variables set, it acts like an
agent: "add a task to …" in chat calls Workbench's `tasks_create` and waits for your approval.

```sh
MOCK_HERMES_PORT=8643 \
MOCK_HERMES_MCP_URL=http://127.0.0.1:8765/mcp \
MOCK_HERMES_MCP_TOKEN="$(cat ~/Library/Application\ Support/Workbench/mcp_token)" \
node tools/mock-hermes/server.js
```

Only one Workbench should run at a time: the app and a standalone `workbench-core` share the same
data directory and port.

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
