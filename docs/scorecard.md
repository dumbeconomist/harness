# Scorecard

| Date | Feature / Milestone | Round | Reviewer | Fn | Fit | Safety | UX | Robust | Weighted | Verdict | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 2026-10-20 | G0 Foundation | 1 | Opus (independent) | 6.0 | 6.0 | 4.0 | 6.0 | 7.0 | **5.70** | FAIL (3×P0) | P0: focus-steal approve (space), global ⌘↵ approve, undo clobbers later edits. P1: idempotency false-success, shared agent/user token, shipped wiring (random port, rotating token, 8642≠8643, no Hermes settings UI), Esc denies. Server-side gate held under probing. |
| 2026-10-20 | G0 Foundation | 2 | Opus (independent, new) | 7.5 | 7.0 | 5.0 | 7.0 | 7.5 | **6.80** | FAIL (2×P0) | Round-1 P0s and P1s verified fixed (shipped wiring partly). New P0: tier-2 Review→Approve keeps keyboard focus (Enter,Enter deletes); Approvals list double-click approves next row. P1: palette approve race; macOS shell E0405 (SecretStore not exported); Hermes profile still used UI token. |
