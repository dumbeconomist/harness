# Hermes Workbench — Architecture & Contracts (G0)

Workbench is a Mac workspace for doing work *with* AI. **Hermes is the brain; Workbench owns the
objects, the tools, and the approval gate.**

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

Why a standalone core: every byte of logic is testable on Linux CI and in the dev container
(no WebKit needed). The UI talks HTTP in dev, test and production alike — no mocked IPC.

## Repo layout
| Path | What |
|---|---|
| `core/` | Rust crate `workbench-core` (lib + bin). axum, tokio, rusqlite (bundled), serde, reqwest |
| `src-tauri/` | Tauri 2 shell. Built only on macOS CI. Starts core in-process on a random port |
| `web/` | React 18 + TypeScript + Vite app. `web/src/features/<feature>/` |
| `tools/mock-hermes/` | Node mock of Hermes' OpenAI-compatible API (SSE, tool calls, usage) |
| `e2e/` | Playwright tests: core binary + mock-hermes + built web app |
| `docs/` | architecture, rubric, scorecard, hermes-integration |

## Core configuration (env vars)
| Var | Default | Meaning |
|---|---|---|
| `WORKBENCH_ADDR` | `127.0.0.1:8765` | bind address (refuse non-loopback unless `WORKBENCH_ALLOW_REMOTE=1`) |
| `WORKBENCH_TOKEN` | generated, written to `$DATA_DIR/token` | bearer token required on `/api/*` and `/mcp` |
| `WORKBENCH_DATA_DIR` | `~/Library/Application Support/Workbench` (macOS) / `~/.local/share/workbench` | SQLite + docs |
| `HERMES_URL` | `http://127.0.0.1:8642/v1` | brain endpoint (OpenAI-compatible) |
| `HERMES_API_KEY` | none | bearer for Hermes API server |
| `WORKBENCH_APPROVAL_TIMEOUT_SECS` | `300` | how long an MCP tool call waits for a human decision |

CORS: allow `http://localhost:*`, `http://127.0.0.1:*`, `tauri://localhost`.

## Risk tiers (enforced in core, never in prompts)
| Tier | Kind | Example | Default policy |
|---|---|---|---|
| 0 | read | `tasks_list` | run, journaled as read=false (not journaled) |
| 1 | reversible write | `tasks_create`, `tasks_update` | **ask**; user may set policy `auto` per tool |
| 2 | destructive / external | `tasks_delete`, later `mail_send` | **always ask**; `auto` not allowed |
| 3 | gated by permission switch | terminal, web, files (later) | refused unless switch ON, then tier-2 rules |

Permission switches (all OFF by default): `web`, `files`, `mail`, `terminal`, `calendar`, `code`.
Tasks/docs domain tools are not switch-gated.

## Data model (SQLite)
```
tasks(id TEXT PK, title, notes, status TEXT CHECK in (todo,doing,blocked,done), goal_id NULL,
      created_at, updated_at)
approvals(id TEXT PK, tool, tier INT, args_json, summary, status TEXT in (pending,approved,denied,expired),
          requested_by TEXT, created_at, decided_at NULL, note NULL)
journal(id TEXT PK, ts, actor TEXT in (agent,user), tool, args_json, result_json, approval_id NULL,
        idempotency_key NULL UNIQUE, inverse_json NULL, undone_at NULL)
ledger(id TEXT PK, ts, run_id, model, prompt_tokens INT, completion_tokens INT, cost_usd REAL, source TEXT)
settings(key TEXT PK, value_json)
```
IDs are ULIDs or UUIDv7 strings. Timestamps are RFC3339 UTC strings.

## App API (`/api`, JSON, bearer auth)
| Method & path | Body / query | Returns |
|---|---|---|
| `GET /api/health` (no auth) | | `{ok:true, version, hermes:{reachable:bool}}` |
| `GET /api/tasks` | `?status=` | `Task[]` |
| `POST /api/tasks` | `{title, notes?, status?}` | `Task` (actor=user, journaled, no approval) |
| `PATCH /api/tasks/:id` | partial Task | `Task` |
| `DELETE /api/tasks/:id` | | `204` |
| `GET /api/approvals` | `?status=pending` | `Approval[]` |
| `POST /api/approvals/:id/decision` | `{decision:"approve"\|"deny", note?}` | `Approval` |
| `GET /api/journal` | `?limit=50` | `JournalEntry[]` newest first |
| `POST /api/journal/:id/undo` | | `JournalEntry` (409 if not undoable / already undone) |
| `GET /api/ledger/summary` | | `{total_usd, by_model:[{model,usd,tokens}], by_day:[{day,usd}]}` |
| `GET /api/ledger/entries` | `?limit=` | `LedgerEntry[]` |
| `GET /api/settings/permissions` | | `{web:false,...}` |
| `PUT /api/settings/permissions` | full object | same |
| `GET /api/settings/policies` | | `{ "<tool>": "ask"\|"auto" }` |
| `PUT /api/settings/policies` | | same (tier-2 tools cannot be set to auto → 400) |
| `POST /api/chat` | `{messages:[{role,content}], context?:{kind,id}}` | **SSE**: `event: delta {text}`, `event: done {usage}`, `event: error {message}`; ledger entry recorded on done |
| `GET /api/events` | `?token=` allowed (EventSource can't set headers) | **SSE** of `{type, payload}`: `approval.created`, `approval.decided`, `journal.appended`, `journal.undone`, `task.changed`, `ledger.appended` |

Errors: `{error:{code,message}}` with appropriate HTTP status.

## MCP server (`POST /mcp`)
JSON-RPC 2.0 over MCP "streamable HTTP" (respond with `application/json` for single responses;
SSE not required in G0). Protocol version `2025-06-18`. Methods: `initialize`,
`notifications/initialized`, `tools/list`, `tools/call`, `ping`. Bearer auth.

G0 tools (names use `_` — some clients reject dots):
| Tool | Tier | Input |
|---|---|---|
| `tasks_list` | 0 | `{status?}` |
| `tasks_create` | 1 | `{title, notes?, status?, idempotency_key?}` |
| `tasks_update` | 1 | `{id, title?, notes?, status?, idempotency_key?}` |
| `tasks_delete` | 2 | `{id, idempotency_key?}` |

`tools/call` flow for tier ≥ 1:
1. Idempotency: if `idempotency_key` given and already in journal → return stored result, do nothing.
   If not given, core derives one = sha256(tool + canonical args) valid for 10 min.
2. Policy `auto` (tier 1 only) → execute. Otherwise create `approval(pending)`, emit
   `approval.created`, and **block** until decided or timeout.
3. Approved → execute, journal with `approval_id` and `inverse_json`, return result.
   Denied → `{isError:true, content:[{type:"text",text:"Denied by user: <note>"}]}`.
   Timeout → approval `expired`, same isError shape.
Tool results: `{content:[{type:"text", text:<json string>}], structuredContent:<obj>}`.

## Undo (journal inverse ops)
`tasks_create` → inverse `{op:"delete", id}`; `tasks_update` → `{op:"restore", task:<before>}`;
`tasks_delete` → `{op:"recreate", task:<before>}`. Undo applies the inverse, sets `undone_at`,
appends a journal entry (actor=user, tool=`undo`). Undo of an undo is not supported.

## Brain adapter
`trait Brain { async fn chat_stream(&self, req) -> Stream<BrainEvent> }` with `HermesBrain`
(OpenAI-compatible `/chat/completions`, `stream:true`, `stream_options:{include_usage:true}`).
Cost: price table in `core/src/ledger/prices.rs` (per-1M token prices by model-name prefix;
unknown → 0 and flagged `source:"unpriced"`).

## Web app config
`window.__WORKBENCH__ ?? {baseUrl: import.meta.env.VITE_WORKBENCH_URL, token: import.meta.env.VITE_WORKBENCH_TOKEN}`.

## Library entry point (used by the Tauri shell and the bin)
```rust
pub struct Config { pub addr: SocketAddr, pub token: Option<String>, pub data_dir: PathBuf,
                    pub hermes_url: String, pub hermes_api_key: Option<String>,
                    pub approval_timeout: Duration }
impl Config { pub fn from_env() -> anyhow::Result<Config> }
pub struct RunningServer { pub addr: SocketAddr, pub token: String, /* shutdown handle */ }
impl RunningServer { pub async fn shutdown(self) }
pub async fn serve(config: Config) -> anyhow::Result<RunningServer>   // binds, spawns, returns
```
Port `0` means "pick a free port" (the shell uses this).

## G0 round-2 contract changes (supersede anything above)
Driven by the round-1 review (see scorecard.md).

**Two credentials.** `ui token` (`WORKBENCH_TOKEN`, file `$DATA_DIR/token`) is accepted ONLY on `/api/*`.
`mcp token` (`WORKBENCH_MCP_TOKEN`, file `$DATA_DIR/mcp_token`) is accepted ONLY on `/mcp`.
Both are generated once and **persisted and reused** across launches (env var overrides file).
`RunningServer` exposes `token` and `mcp_token`.

**Stable address.** Default `WORKBENCH_ADDR=127.0.0.1:8765`. The Tauri shell binds 8765; if busy it
falls back to port 0 and `/api/health` reports `{addr, addr_fallback:true}` so the UI can warn
"Hermes is configured for :8765 but Workbench is on :NNNN".

**Hermes defaults to the locked profile:** `HERMES_URL` default `http://127.0.0.1:8643/v1`.

**Secrets.** `Config.secret_store: Option<Arc<dyn SecretStore>>` with
`trait SecretStore: Send+Sync { fn get(&self,k:&str)->Option<String>; fn set(&self,k:&str,v:&str)->anyhow::Result<()>; }`.
The Tauri shell provides a Keychain impl; with none, keys are memory-only and `/api/settings/hermes`
reports `key_persisted:false`.

**New endpoints (ui token):**
- `GET /api/settings/hermes` → `{url, has_key, key_persisted, reachable, model}` (never returns the key)
- `PUT /api/settings/hermes` `{url?, api_key?}` → persists url in settings, key via SecretStore,
  hot-swaps the brain (no restart); returns the GET shape
- `GET /api/settings/connection` → `{mcp_url, mcp_token, hermes_config_snippet}`: what the user
  pastes into the Workbench Hermes profile (shown behind a "reveal" in Settings)

**Undo is conflict-safe.** Journal entries store field-level `before` and the `after.updated_at`.
Undo returns **409 `{code:"stale"}`** when the object changed since that entry (or no longer
exists for update; for create-undo, if it was edited after creation). Message tells the user which
newer entry to undo first.

**Idempotency.** Each journal row stores `args_hash`. Explicit key reused with a different
tool/args hash → tool error `"idempotency key reused with different arguments"` (no execution).
Derived keys: window **60 s** and the hash includes the target object's current `updated_at`
(update/delete) — and for create, dedupe only if the previously created object still exists unchanged.

**Ledger summary** adds `{total_tokens, unpriced_runs}` and per-model `{priced:bool}`.

**Approval card keyboard rules (UI):** never steal focus on mount; ⌘↵ / Esc act only when focus is
inside the card; ignore `e.repeat` and any key within 600 ms of mount; Esc never denies (collapses
the card to the badge); tier 2 requires a pointer click or focused-card ⌘↵ after an explicit
"Review" expand. Full arguments always viewable; updates show old → new.

**Mock Hermes agent loop.** When `MOCK_HERMES_MCP_URL` + `MOCK_HERMES_MCP_TOKEN` are set and the last
user message matches `/add (?:a )?task(?: to)? (.+)/i`, the mock emits
`event: hermes.tool.progress {tool:"mcp__workbench__tasks_create",toolCallId,status:"running"}`,
calls `/mcp` `tools/call tasks_create {title}` (blocking), then emits `status:"completed"` and streams
`Added task: <title>` or `Could not add task: <error text>`.

## G1 contract: Shell & command surface (supersedes nothing above; additive)

### Core (new)
**Doctor tracking.** Core records (in memory, plus `settings` for persistence across restarts):
`mcp.last_initialize_at`, `mcp.last_tools_list_at`, `mcp.last_tool_call_at`, `mcp.client_info`
(from initialize `clientInfo`), `brain.last_ok_at`, `brain.last_error {at, status, message}`.

`GET /api/doctor` (ui token) → `{ok: bool, checks: Check[]}`. Checks run in order; a later check is
`skip` if an earlier blocking one fails.
```
Check = {id, title, status: "ok"|"warn"|"fail"|"skip", message, fix?: string, blocking: bool}
```
| id | How | fail / warn → fix text |
|---|---|---|
| `hermes_reachable` | GET `{HERMES_URL}/models` (3s) | fail: "Start the locked profile: `hermes -p workbench gateway run`" |
| `hermes_auth` | same response: 401/403 = fail | fail: "Paste the profile's API_SERVER_KEY in Settings → Hermes" |
| `hermes_model` | POST `/chat/completions` max_tokens 1, non-stream (8s); only when `?deep=1` | fail with the upstream error |
| `mcp_connected` | `mcp.last_initialize_at` set | warn: "Hermes hasn't connected to Workbench yet. Add WORKBENCH_MCP_TOKEN to the profile .env and restart the gateway" |
| `mcp_tools_seen` | `mcp.last_tools_list_at` set | warn: "Hermes connected but never listed tools; check `mcp_servers.workbench` in the profile config.yaml" |
| `profile_locked` | GET `{HERMES_URL}/toolsets` (or `{base}/v1/toolsets`) if 200: fail if `terminal` or `file` has `enabled:true`; 404 → warn "can't verify" | fail: "Hermes can use its own terminal/file tools, which bypass Workbench approvals. Use the locked profile (README step 1)" |
`ok` = no `fail` among blocking checks. Doctor never returns secrets.

**Threads.** Migration adds:
```
threads(id TEXT PK, context_kind TEXT NULL, context_id TEXT NULL, title TEXT, created_at, updated_at)
messages(id TEXT PK, thread_id TEXT REFERENCES threads(id) ON DELETE CASCADE, role TEXT CHECK in (user,assistant,tool),
         content TEXT, tool_json TEXT NULL, created_at)
```
- `GET /api/threads?context_kind=&context_id=` → `Thread[]` newest first
- `POST /api/threads {context_kind?, context_id?, title?}` → `Thread`
- `GET /api/threads/:id/messages` → `Message[]` oldest first
- `DELETE /api/threads/:id` → 204
- `POST /api/chat` accepts `thread_id?`. When present, core persists the user message before
  streaming and the assistant message (plus tool chips as `role:"tool"` rows with `tool_json`) on done,
  and sends `X-Hermes-Session-Id: <thread_id>`. When `thread_id` is present, `messages` in the body is
  ignored except the last user message; history comes from the DB. Old callers (no thread_id) keep working.

**Undo helper.** `GET /api/journal/latest-undoable` → `JournalEntry | null` (newest entry with an inverse,
not undone, not stale-blocked).

**Ledger.** `GET /api/ledger/summary` adds `today_usd`, `last7_usd`, `last30_usd`, and `by_day` covers the last
14 days including zero days. `GET /api/ledger/entries?limit=` already exists.

### Web (new)
- `web/src/lib/commands.ts`: one registry `Command {id, title, keywords, slash?, run(args, ctx)}`
  used by the ⌘K palette AND the quick bar. Slash commands: `/task <title>`, `/ask <q>`, `/find <text>`,
  `/goto <tasks|approvals|activity|ledger|settings>`, `/undo` (shows the entry and requires an explicit
  confirm click or a second Enter on a *Confirm* button that appears after a 600ms arm), `/status` (doctor).
  **No command may approve or deny.**
- Route `#/quick` renders `QuickBar` only (no sidebar): a single input, suggestions list, result area,
  and an "N approvals waiting → Open" link that posts `workbench:open-main` (shell) or navigates (web).
  Esc posts `workbench:hide-quick`. Free text with no slash = `/ask`.
- Settings → **Connection doctor** panel (Run / Run deep). An app-wide banner shows when the doctor's `ok`
  is false, with the first failing check and its fix; it can be dismissed for the session.
- ChatPane: thread per context (task id or "general"), a thread switcher, "New thread", history loaded on open.
- Ledger: 14-day SVG bar chart, today/7d/30d tiles, per-run table.
- Notifications (web side): when `document.visibilityState === 'hidden'` or the window lacks focus and
  `approval.created` arrives, call `window.__WORKBENCH_NATIVE__?.notify({title, body, approvalId})` if present
  (the shell injects it); else use the browser Notification API if granted. Clicking → focus the approval card.
  Notifications carry no approve/deny actions. Badge: `window.__WORKBENCH_NATIVE__?.setBadge(count)`.

### Shell (new)
- Second window `quick` (label `quick`): 640×360, `decorations(false)`, `always_on_top(true)`,
  `skip_taskbar(true)`, `visible(false)`, `center()`, url `index.html#/quick`, same initialization script.
  ⌥Space toggles **quick** (show+focus / hide). It hides on blur. The old palette-on-main behaviour moves to ⌘K only.
- `tauri-plugin-notification`; inject `window.__WORKBENCH_NATIVE__ = {notify, setBadge}` via JS→Rust
  commands `native_notify`, `native_set_badge` (tray tooltip/title shows the pending count; dock badge
  via `set_badge_count` if available, otherwise tray title only).
- Events from web: `workbench:open-main` → show and focus main and emit `workbench:focus-approval` into main;
  `workbench:hide-quick` → hide quick. Implement as Tauri commands `open_main`, `hide_quick`, which the web
  calls through `window.__TAURI_INTERNALS__` only when present (guard for browser/e2e).
