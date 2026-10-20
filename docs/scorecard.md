# Scorecard

| Date | Feature / Milestone | Round | Reviewer | Fn | Fit | Safety | UX | Robust | Weighted | Verdict | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 2026-10-20 | G0 Foundation | 1 | Opus (independent) | 6.0 | 6.0 | 4.0 | 6.0 | 7.0 | **5.70** | FAIL (3×P0) | P0: focus-steal approve (space), global ⌘↵ approve, undo clobbers later edits. P1: idempotency false-success, shared agent/user token, shipped wiring (random port, rotating token, 8642≠8643, no Hermes settings UI), Esc denies. Server-side gate held under probing. |
