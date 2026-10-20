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
