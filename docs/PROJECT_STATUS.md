# Project status — runtime contract

## Single-truth state

| Element | Single source |
|---|---|
| Database | Docker Postgres 16 (`DATABASE_URL`) |
| Schema | `lib/db/schema/**` + `drizzle/*.sql` migrations |
| Automation runtime | `apps/worker` (`pnpm worker`) — boots Postgres, starts orchestrator |
| Web runtime | Next.js at repo root (`pnpm dev`) — UI + read APIs; no workers |
| Event/audit log | `domain_events` (Postgres, BIGSERIAL, dedupe-keyed) |
| Trade lifecycle | `paper_positions.state` + `live_trades.status` (row state is intentional recovery model) |

**Decision (2026-05):** `@spr/core/trade-fsm` / `trades_fsm` table remain **unwired**. Crash recovery relies on open row state in `paper_positions` and `live_trades`, not a separate FSM table. Revisit if unattended live sessions need formal INTENT→CLOSED audit trails.

## Hard rules

1. **PostgreSQL is the only durable truth.** No PGlite, no second store.
2. **`apps/worker` is the only automation runtime.** Next.js does not boot workers (`instrumentation.ts` only records a perf note).
3. **Web writes go through `executeWebMutation`** from `@spr/db` (closed `WebWriteOp` enum). Direct writes to `app/api/**` from `@spr/db` are linted as warnings until each route is migrated.
4. **No `.NET` launcher, no Visual Studio dependence.** Cursor / VS Code only, WSL2 recommended on Windows.
5. **Worker memory is a projection.** On boot, `apps/worker` connects to Postgres, runs migrations, then starts the orchestrator. DB wins on any mismatch.

## Run

```bash
pnpm db:up && pnpm db:migrate
pnpm dev          # terminal 1 (UI/API)
pnpm worker       # terminal 2 (automation)
```

Verify Postgres visibility from the UI: `GET http://127.0.0.1:3000/api/runtime/postgres`.  
Diagnostics: `GET http://127.0.0.1:3000/api/diagnostics/runtime`.

## Post-review verification (2026-05)

| Check | Status |
|---|---|
| Gap 3 — MTM skips exit-in-flight | Closed — paper MTM OPEN-only; live has no MTM lane |
| P2.4 — `paper_trades_compat` VIEW | Dropped via migration `0017_drop_paper_trades_compat.sql` |
| P2.3 — Engine B env vars | Wired — `envContinuation()` + `AUTO_CONTINUATION` auto-gate |
| P2.1a — shadow learner default off | `SHADOW_LEARNER=off` default; worker logs disabled at boot |
| P2.1b — shadow learner executor | `paperOpen`/`paperClose`/`loadOpenPositions` via `@/lib/paper/engine` → `@spr/trading`; no `paper-trades` repo |
| P0.1 edge — dex-only module scores | Fallback from `token_features` when analytics has no row |
| P2.2 — demo entry frequency | `pnpm demo:freq-check --watch` with worker live. Option A confirmed: `qualifyEntry` always; `AUTO_DEMO_RELAX` only bypasses bundle/mechanical in demo. |

**Paper Gap 3 SQL** (not `live_trades` — no unrealized column there):

```sql
UPDATE paper_positions SET state = 'CLOSING' WHERE id = '<open id>';
-- wait 15s
SELECT id, state, unrealized_pnl_sol, updated_at FROM paper_positions WHERE state = 'CLOSING';
```

## What still needs doing (optional / deferred)

- **Physical move of Next under `apps/web/`.** Cosmetic; product runs fine at repo root.
- **Optional: wire `@spr/core/trade-fsm`.** Retired in favor of row-state recovery (see Single-truth table above).

## Completed (2026-05)

- **Review fix plan (P0–P3).** Verified via `pnpm check` and `pnpm verify:review`.
- **Web read path consolidation.** All GET routes delegate SQL to shared repos/helpers (`pnpm audit:api-reads` → 0 inline reads).
- **Web write gate.** All mutating routes with DB writes use `executeWebMutation` / `queueWebCommand` (`pnpm audit:web-writes` → PASS).

## Verification

```
pnpm install
pnpm typecheck
pnpm test
pnpm test:core
pnpm --filter @spr/worker exec tsc --noEmit
pnpm lint
pnpm verify:review      # post-review SQL smoke (heartbeats, module_scores, VIEW)
pnpm demo:freq-check    # P2.2 entry frequency verdict
pnpm audit:web-writes   # mutating routes use web-write gate
pnpm audit:api-reads    # GET routes with inline getDb() (expect 0)
```
