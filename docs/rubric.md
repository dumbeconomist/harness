# Feature Rubric & Gating

Every feature (and every milestone) is scored 0–10 by a **fresh Opus reviewer** that did not
write the code, using evidence: test output, e2e screenshots, the diff, and this rubric.

## Hard gates — no score is given until all pass
1. `cargo test` (core) green; `cargo clippy -- -D warnings` clean
2. `pnpm -C web test` (vitest) green; `pnpm -C web typecheck` and `lint` clean
3. Playwright e2e green against core + mock-hermes + built web app
4. No open P0 (data loss, approval bypass, crash on happy path, secret leak)

## Weighted dimensions
| Dimension | Weight | 10 looks like | ≤5 looks like |
|---|---|---|---|
| Function | 30% | Every acceptance criterion demonstrably works, incl. edge cases | Happy path only, or criteria missing |
| Workflow fit (work *with* AI) | 25% | AI proposes on shared objects, you steer/approve in place; low friction | Chat-in-a-box; you copy/paste between AI and work |
| Safety & approvals | 20% | Writes/sends cannot bypass the gate; undo works; idempotent; secrets never reach model/logs | Gate is advisory, or any bypass path exists |
| UX polish | 15% | Keyboard-first, clear states (empty/loading/error), feels native, consistent | Raw/unstyled, confusing states |
| Robustness & tests | 10% | Meaningful tests at each layer, failure modes handled (Hermes down, timeouts) | Thin tests, crashes on errors |

**Pass = weighted ≥ 8.5.** Below that, the reviewer lists concrete, testable deltas ranked by
score impact; builders fix; re-score. **Max 4 rounds per feature**, then escalate to the user with
the blockers. Reviewer must cite evidence for every dimension score — no evidence, no points.

## Milestone gate (human)
After the Opus gate passes, macOS CI builds a `.dmg`. The user installs it on an M2 against real
Hermes, runs the milestone checklist below, and records their own score in `scorecard.md`.
Next milestone starts only on user sign-off.

## G0 acceptance criteria — Foundation & Hermes spike
- [ ] Core serves `/api/*` and `/mcp` per `architecture.md`, token-authenticated, loopback only
- [ ] MCP `tools/call tasks_create` blocks → approval appears in UI live (SSE) → Approve creates
      the task; Deny returns an MCP error and creates nothing; timeout expires the approval
- [ ] Undo of create / update / delete restores prior state; journal shows both entries
- [ ] Same idempotency key twice → executed once
- [ ] Tier-2 tool cannot be set to `auto` policy (API rejects)
- [ ] Chat pane streams from Hermes (mock in CI) and records a ledger entry with cost
- [ ] Ledger view shows totals by model and day
- [ ] Hermes integration documented & verified: API server config, MCP registration of Workbench
- [ ] Linux CI runs all tests; macOS CI produces an Apple-Silicon `.dmg`

**Human checklist (M2):** install dmg → app opens → set Hermes URL/key → ask Hermes (in chat
pane) to "add a task to buy milk" → approval card appears → approve → task listed → undo removes it.

## Later-milestone hero features (from research)
- **Routines gallery** (Town): templates for inbox triage, meeting briefing, morning brief, deal
  spotting, competitive intel, newsletter digest; plus "describe your own" → Hermes cron/skill. (G2/G4)
- **Autonomy ladder** (Town): Workbench tracks approve-without-edit streaks per tool and *suggests*
  promoting tier-1 tools to `auto`; never auto-promotes; tier-2 never eligible. (G2)
- **Style profile** (Town "learns how you work"): drafts use a user-editable voice profile stored
  in Hermes memory. (G4)
