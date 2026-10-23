# AGENTS.md

Start here: **[`docs/HANDOFF.md`](docs/HANDOFF.md)**. It covers the project, architecture, how to run and test, current status, next steps, and the rules you must not regress.

Quick rules:
- **Hard gates before every push:**
  - `cargo fmt --check -p workbench-core && cargo clippy -p workbench-core --all-targets -- -D warnings && cargo test -p workbench-core`
  - `node --test tools/mock-hermes/server.test.js`
  - `pnpm -C web typecheck && pnpm -C web lint && pnpm -C web test`
  - `cd e2e && npx playwright test`, then `git checkout -- e2e/screenshots` unless you intend to update them.
- **Never run `playwright install`.** Chromium is preinstalled.
- `src-tauri/` only compiles on macOS CI (`.github/workflows/macos-build.yml`). Verify Tauri APIs against the crate sources before pushing.
- The binding contract is `docs/architecture.md`, the acceptance criteria are in `docs/rubric.md`, and every review round is logged in `docs/scorecard.md`.
- **Approval-gate safety rules (HANDOFF §6) are non-negotiable.** Nothing outside the approval card may approve or deny, nothing moves focus onto a card on its own, and secrets are redacted before any upstream text is clipped.
- Work on branch `claude/lucid-newton-glulj5`. Don't open a PR unless the owner asks.
