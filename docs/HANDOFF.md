# Handoff: Hermes Workbench

This document is for the next agent (e.g. Codex) or engineer picking up this repo. It covers what the project is, how it's built, how to run and test it, where work stands, and what to do next. Read it end to end before changing anything. The rules in **§6 (hard-won rules)** exist because a reviewer found real bugs that broke them.

Branch: `claude/lucid-newton-glulj5` · Last handoff commit: see `git log -1` · Date: 2026-10-23

---

## 1. What this is

**Hermes Workbench** is a macOS workspace for *doing work with AI*, not just asking it things. The owner runs **Hermes Agent** (Nous Research, open source) on M2 MacBooks.

- **Hermes is the brain.**
- **Workbench owns the objects and the tools:** tasks now; docs, mail, CRM, research and repos later.
- **Workbench owns a hard approval gate:** the AI proposes a change, the human approves or denies it in Workbench, every change is journaled and undoable, and spend is tracked in a ledger.

We deliberately do **not** rebuild a chat client: Nous already ships Hermes Desktop for that. Design inspiration, with the features borrowed from each, is in the plan summary in `docs/architecture.md` and in `README.md`:

| Product | Borrowed |
|---|---|
| Pennant | approval cards, cost ledger, goals |
| Ghost | ⌥Space summon, `/` commands, undo journal, permission switches |
| Odysseus | email triage, deep research, doc diffs |
| Town | routines library, earned autonomy |

## 2. Architecture (as built)

```
Tauri 2 shell (src-tauri/, macOS only, thin)
  main window + ⌥Space "quick" window, tray, notifications, Keychain
  injects window.__WORKBENCH__ = {baseUrl, token} and window.__WORKBENCH_NATIVE__
        │ HTTP + SSE, 127.0.0.1:8765, bearer token
workbench-core (core/, Rust: axum, tokio, rusqlite)
  /api/*  app API for the React UI                  (UI token only)
  /mcp    MCP server (JSON-RPC over HTTP) ◄── Hermes (MCP token only)
  approvals · journal (undo, idempotency) · ledger · tasks · threads · doctor
  brain: OpenAI-compatible client ──► Hermes API server :8643 (locked profile)
  SQLite: ~/Library/Application Support/Workbench/workbench.db
web/ (React 18 + TS + Vite): the UI, also served as #/quick for the quick bar
```

Why the core is a standalone server: **WebKitGTK isn't available in the Linux dev container**, so Tauri can't build here. All logic lives in `core/` and is testable on Linux. The shell is thin and only compiles on the macOS GitHub Actions runner.

**Binding contract:** `docs/architecture.md`, which covers the API routes, MCP tools, risk tiers, the data model, the G0 round-2 changes and the G1 contract. If code and contract disagree, fix one deliberately and update the other.

**Hermes integration facts (verified on Hermes 0.19.0):** `docs/hermes-integration.md`. Key points:

- Workbench uses a dedicated **locked Hermes profile** called `workbench`, served on port **8643**.
  - Its own tools terminal, file, code, browser, cron, skills and memory are disabled.
  - So Hermes can only act through Workbench's MCP tools, and every action passes the approval gate.
  - Setup: `tools/hermes-spike/workbench-profile/setup-profile.sh`.
- Hermes names MCP tools `mcp__workbench__<tool>`.
- Set `timeout: 600` for the MCP server in the Hermes config, because Workbench tools block while waiting for a human decision.
- Hermes streams tool activity as a named SSE event, `hermes.tool.progress`.

### Key files

| Area | Files |
|---|---|
| Core entry, config | `core/src/lib.rs` (`serve()`, `RunningServer`), `core/src/config.rs`, `core/src/main.rs` (SIGINT/SIGTERM) |
| Approval gate | `core/src/approvals.rs`, `core/src/policy.rs` (tiers, ask/auto), `core/src/tools.rs` (MCP tool execution + gate + idempotency) |
| Journal / undo | `core/src/journal.rs` (conflict-safe undo, `409 stale`) |
| MCP server | `core/src/mcp.rs` (protocol negotiation, GET/HEAD/DELETE handling) |
| Brain (Hermes client) | `core/src/brain.rs` (SSE parser, named events, keepalives) |
| Doctor + redaction | `core/src/doctor.rs` (`/api/doctor`, `sanitize_upstream`, startup scrub) |
| Threads | `core/src/threads.rs`, chat in `core/src/api.rs` |
| Ledger | `core/src/ledger/{mod.rs,prices.rs}` |
| Secrets | `core/src/secrets.rs` (`SecretStore` trait; Keychain impl lives in the shell) |
| UI shell / routing | `web/src/App.tsx` (exports `Root`; `#/quick` → QuickBar) |
| Approval UI (**safety-critical**) | `web/src/features/approvals/ApprovalCard.tsx`, `ApprovalsView.tsx`, `web/src/lib/focusApproval.ts` |
| Commands | `web/src/lib/commands.ts` (one registry for ⌘K and the quick bar) |
| Native bridge | `web/src/lib/native.ts`, `alerts.ts`, `handoff.ts` |
| Tauri shell | `src-tauri/src/lib.rs`, `src-tauri/tauri.conf.json`, `src-tauri/capabilities/default.json` |
| Mock Hermes | `tools/mock-hermes/server.js` (OpenAI-compatible SSE; agent loop that really calls `/mcp`; `/v1/toolsets`; failure modes) |
| CI | `.github/workflows/ci.yml` (Linux: core, web, mock, e2e), `.github/workflows/macos-build.yml` (macos-14 → `.dmg`) |

## 3. Run and test

Toolchain: Rust stable, Node 22, pnpm 10. Playwright 1.56.1 is pinned to match the preinstalled Chromium build 1194. **Never run `playwright install` in the container.**

```sh
# hard gates (all must pass before any push)
cargo fmt --check -p workbench-core
cargo clippy -p workbench-core --all-targets -- -D warnings
cargo test -p workbench-core                       # ~144 tests
node --test tools/mock-hermes/server.test.js       # use the FILE path; the dir form runs 0 tests on Node 22
pnpm -C web typecheck && pnpm -C web lint && pnpm -C web test   # ~111 vitest
cd e2e && npx playwright test                      # ~38 specs; starts mock + core + web preview itself
#   if default ports are busy: E2E_CORE_PORT=28765 E2E_MOCK_PORT=28642 E2E_WEB_PORT=24173 npx playwright test
#   e2e rewrites e2e/screenshots/*.png — run `git checkout -- e2e/screenshots` unless you mean to update them
```

Dev loop and Mac setup: see `README.md` → Quickstart (locked profile, tokens, `cargo run -p workbench-core`, `pnpm -C web dev`).

Core env vars: `WORKBENCH_ADDR` (default `127.0.0.1:8765`), `WORKBENCH_TOKEN`, `WORKBENCH_MCP_TOKEN`, `WORKBENCH_DATA_DIR`, `HERMES_URL` (default `http://127.0.0.1:8643/v1`), `HERMES_API_KEY`, `WORKBENCH_APPROVAL_TIMEOUT_SECS`.

**The shell can't compile on Linux.** Push and read the `macos-build` workflow result. When you change `src-tauri/`, verify every Tauri API against the crate sources in `~/.cargo/registry/src` (`cargo fetch --manifest-path src-tauri/Cargo.toml` downloads them without building). CI is the only compiler.

## 4. Process: how work has been gated

Every milestone follows the same loop. Keep it; it caught real bugs every round.

1. **Write the contract first.** Add the milestone's API, UI and shell spec to `docs/architecture.md`, and its acceptance criteria to `docs/rubric.md`.
2. **Build** in parallel by area: core, web, shell, mock/docs.
3. **Hard gates (§3) plus green CI** on Linux and macOS.
4. **Independent review** by a fresh reviewer that did not write the code. It runs the gates, probes adversarially with its own Playwright scripts against a live core and the mock, and scores against `docs/rubric.md`.
   - Weights: Function 30%, Workflow fit 25%, Safety & approvals 20%, UX polish 15%, Robustness & tests 10%.
   - **Pass = weighted ≥ 8.5 and no P0.** A P0 is a realistic path to an unintended approval decision, data loss, a crash on the happy path, or a secret leak.
   - Up to **4 rounds**. After that, escalate to the owner with the remaining blockers; don't inflate scores.
5. **Log every round in `docs/scorecard.md`.**
6. **Human gate:** the owner installs the CI `.dmg` on an M2 and runs the milestone checklist in `docs/rubric.md`.

Commits end with the attribution trailer used throughout `git log`. Push only to `claude/lucid-newton-glulj5` unless the owner says otherwise. No PR has been opened.

## 5. Status

| Milestone | Status |
|---|---|
| **G0** Foundation (core, MCP gate, undo, idempotency, ledger, web UI, shell, CI, Hermes spike) | **Done.** Final review 8.48 with no P0. Its one must-fix (card height) was fixed after scoring. The owner accepted it and chose to defer the M2 test. |
| **G1** Shell & command surface (⌥Space quick bar, `/` commands, notifications + badge, connection doctor, persisted chat threads, ledger chart) | **Code complete, in review.** R1 7.23 (P0 focus steal) → R2 8.23 (must-fix: redaction ran after clipping) → **R3 fixes pushed at `eb85d15`, CI green on Linux and macOS.** The round-3 independent review was started (it was interrupted once by a usage limit). **If no R3 score is in `docs/scorecard.md`, run the R3 review yourself (§7 step 1).** |
| G2–G7 | Not started. Scope is in §8. |

**Never run against real Hermes or on a real Mac.** CI builds the `.dmg` but nothing has exercised it at runtime. The owner's first M2 test will cover G0 and G1 together; the human checklist is at the bottom of `docs/rubric.md`. The connection doctor (Settings, or `/status`) is built to make that first run diagnose itself.

Latest `.dmg`: the `macos-build` workflow artifact for the HEAD commit (Actions tab). It is ad-hoc signed, so the first launch needs right-click → Open.

## 6. Hard-won rules (don't regress these)

Each rule below was a reviewer-found P0 or must-fix. Regression tests exist for most of them in `e2e/specs/*.spec.ts` and `core/tests/*`.

**Approval UI (the most fragile area):**
1. **Nothing may move focus to an approval card or button on its own.**
   - Focus moves only on an *explicit* request: ⌘⇧A, palette "Review pending approval", the quick-bar link, or a notification tap. These send `CustomEvent('workbench:focus-approval', {detail:{explicit:true, approvalId?}})`.
   - On window re-activation, the card only gets a highlight (`data-approval-pulse`).
2. **Decision keys act only when focus is inside the card.** Ignore `e.repeat`. Ignore any input within 600 ms of mount *or of any programmatic focus*. Buttons render visibly disabled during that window.
3. **Esc never denies.** It collapses the card.
4. **Tier 2 (destructive or external) requires an explicit "Review details" step.**
   - After Review, Approve/Confirm appears **in a different screen position** and stays disabled for 1000 ms.
   - Keyboard or screen-reader confirmation needs an explicit opt-in checkbox.
   - **Never render a decision button where the previous click target was.**
5. **The Approvals list re-arms all rows for 600 ms** whenever the set or order of pending ids changes, and after any decision.
6. **No command, palette entry, quick-bar action, notification or banner can approve or deny.** `commands.ts` is scanned by a unit test for decision calls; keep that test.
7. **Never shift layout under the pointer near approvals.** Alerts go in fixed slots, such as the sidebar doctor item, not in reflowing banners. Cards cap their height and pin the decision row.

**Core safety:**
8. **Two tokens.**
   - The UI token works only on `/api/*`; the MCP token works only on `/mcp`.
   - Both are persisted in `$DATA_DIR/{token,mcp_token}`.
   - Hermes gets the MCP token via `WORKBENCH_MCP_TOKEN` in the profile `.env`.
9. **Tier 2 can never be set to `auto`.** The gate lives in core, never in prompts.
10. **Undo is conflict-safe.** Return `409 {code:"stale"}` instead of overwriting later edits.
11. **Idempotency.** Each explicit key has an args hash, and reusing a key with different args is an error. Derived keys last 60 s and are state-aware. Concurrent calls with the same key share one approval.
12. **Redact secrets before clipping any upstream text.** Use `doctor::sanitize_upstream` for every string that came from Hermes: errors, doctor output, SSE and logs. Never log tokens or keys.
13. **Loopback only, with an Origin check** on `/api` and `/mcp`.

## 7. Next steps (in order)

1. **Finish the G1 gate.**
   - If `docs/scorecard.md` has no G1 round-3 row, run an independent review of HEAD per §4: gates, adversarial probes, and scoring against the G1 criteria in `docs/rubric.md`.
   - Probe hardest at the §6 rules and at secret redaction: straddle a secret across the 300-char clip, and try URL-encoded, JSON-escaped and chunked variants.
   - Log the result.
   - If it scores ≥ 8.5 with no P0, G1 passes. Otherwise run round 4: fix the listed deltas, gate, push, re-review.
   - After round 4, escalate to the owner rather than looping.
2. **Hand the owner the M2 test** (G0+G1): the `.dmg` from the HEAD `macos-build` run, plus the human checklist in `docs/rubric.md`. Expect real-Hermes issues, and use the doctor output to triage them. Areas most likely to need runtime fixes:
   - ⌥Space clashing with Spotlight or input sources
   - whether `on_action("tap")` fires for an ad-hoc-signed app
   - whether `app.hide()` affects the tray
   - Keychain prompts
   - `visible_on_all_workspaces` over fullscreen apps
3. **G2: Tasks, Goals & Routines** (only after M2 sign-off, unless the owner says otherwise). Steps 3–5 are known open items, deferred to G2 in earlier rounds.
   - Kanban.
   - Goals with a measure, a budget and a task breakdown.
   - Agent progress posts.
   - Heartbeat and scheduled jobs via Hermes cron. **First verify that the cron toolset restriction holds in the locked profile; this is untested.**
   - A **routines gallery**, Town-style templates (inbox triage, meeting brief, morning brief, deal spotting) plus describe-your-own.
   - An **autonomy ladder**: suggest promoting a tier-1 tool to `auto` after N approve-without-edit decisions. Never auto-promote, and tier 2 is never eligible.
   - A daily brief.
4. Decide how MCP tool calls are tied to a chat thread. Hermes doesn't forward the session id to MCP; a per-profile `identity_header` is the practical option (see `docs/hermes-integration.md`).
5. Permission-switch plumbing lands with the first switch-gated tool (G3/G4).

## 8. Later milestones (scope)

| Milestone | Scope |
|---|---|
| **G3** Docs & writing | Markdown editor; AI edits arrive as inline diffs to accept or reject; select-text rewrite bar; FTS5 search; DOCX/PDF export |
| **G4** Email & CRM | Gmail OAuth + IMAP/SMTP; triage; drafts never sent without tier-2 approval; lightweight CRM auto-filled from mail and calendar; a style profile in Hermes memory |
| **G5** Research | Steerable multi-step research to a cited report saved as a Doc; blind model compare |
| **G6** Code & repos | Hermes / Claude Code / Codex sessions in git worktrees; diff review; PR creation behind approval |
| **G7** Hardening | Hermes memory and skills browser; backup and export; accessibility; a notarized build (needs the owner's Apple Developer ID) |

## 9. Gotchas

- `node --test tools/mock-hermes/` with a directory argument runs **zero** tests on Node 22. Use the file path.
- e2e specs share one core DB. `z-g1.spec.ts` is named to run after `workbench.spec.ts` on purpose.
- The mock model `hermes-agent` is unpriced, so e2e ledger costs are $0 with an "unpriced" flag. Priced cost maths is covered by core tests.
- The Mac app and a standalone `workbench-core` share `~/Library/Application Support/Workbench` and port 8765. Run only one at a time.
- Hermes `API_SERVER_KEY` must be **≥ 16 chars**. The docs say 8, but a shorter key makes the adapter refuse to start.
- `pip install hermes-agent` needs the `[mcp,messaging]` extras for the MCP client and the API server.
- Doctor check titles are neutral nouns ("Hermes API", "API key", …). e2e asserts them.
- `target/` is gitignored. Don't commit build output.
