# Codebase cleanup register

Status: **CURRENT**. Output of the Phase 0 audit and the Group 1–3 hardening pass.

Nothing in this register has been deleted. Per the audit's protection rule, items that look
dead are **documented here** rather than removed, because several turned out to be deliberate
reservations or future wiring rather than accidents.

---

## Built but not wired

| Item | File | Why it is not dead | Action |
|---|---|---|---|
| `fast-lane` | `lib/intelligence/fast-lane.ts` | Pure, tested core (`shouldFastLaneFire` + `FastLaneQueue`). Its docstring claims an env gate `FAST_LANE=on`, but **that key does not exist in `lib/env.ts`** — the gate is unreachable, not merely off. Nothing imports it except its own test. | KEEP. Wiring it is a latency project, out of scope. |
| `mode-authority` | `lib/runtime/mode-authority.ts` | Complete two-phase demo⇄real commit with replay guard, staleness guard and confirm-phrase gating, plus tests. **No production caller.** The real switch is a bare `setUiTradingMode` (`web-command-listener.ts:132`) with none of those guards. | KEEP. Wire at the live-trading phase. |
| `write-queue` | `lib/db/write-queue.ts` | 24-line passthrough; its own docstring says it is retained only to keep diagnostics endpoints stable. There is **no** async write queue, no retries, no backpressure. | KEEP as-is; do not mistake it for a queue. |
| `dead_letters` table | `lib/db/schema/ops.ts:24` | Schema + index exist; **zero writers and zero readers** repo-wide. `SYSTEM_DESIGN.md:233` listed it as live infrastructure — that doc line was stale. | KEEP table; **doc corrected** (`SYSTEM_DESIGN.md:233,702` now mark it reserved). |
| `ABLATION_VARIANT` / `ABLATION_MODE` | `lib/env.ts:158-159` | Validated but never read. The docblock says *"The live switch is reserved; default off"* — a deliberate reservation. | KEEP. Do **not** delete. |
| `@spr/core` trade FSM / `trades_fsm` | `packages/core` | Intentionally unwired; `PROJECT_STATUS.md` records the decision that row-state recovery won. | KEEP. |
| PumpSwap on-chain timestamp | `lib/pump/pumpswap-parser.ts:57` | `decodeSwap` reads the event's own `i64` timestamp and discards it (`r.i64(); // timestamp`), then uses the caller clock. Swaps are therefore truthfully labelled `ts_source='local'`. | Candidate: use the real value to upgrade swap provenance to `chain`. Changes stored `blockTime` **values**, so it needs its own change. |

---

## Corrected audit findings

Items I flagged during the audit that did **not** survive verification. Recorded so they are
not re-flagged.

| Claim | Verdict | Evidence |
|---|---|---|
| Auto-trader queries the wrong PnL column (`pnl_sol`) | **FALSE** | `auto-trader.ts:131,301` correctly use `realized_pnl_sol` on `paper_positions`; `:311` correctly uses `pnl_sol` on `live_trades`, which really has that column. `pnl_sol` is also a legitimate alias inside `PAPER_TRADES_READ` (`paper-read.ts:22`). A blanket rename would **break** the live path and the analytics repos. |
| Live exits evaluate TP before SL — a priority bug | **UNREACHABLE** | `start/route.ts:42,45` enforce `takeProfitPct > 0` and `0 < stopLossPct < 1`, so `pct >= tpPct` and `pct <= -slPct` are mutually exclusive. The ordering can never change an outcome. Not changed — editing real-money code for a non-bug is a net negative. |
| `chartCache` LRU `continue`-after-`shift()` is a bug | **BY DESIGN** | The `continue` protects entries active within 10 minutes from eviction. `MAX_WARM_MINTS` is therefore a *soft* cap; the real bound is the 10-minute idle window, reclaimed by `evictCold()` on the chart-reconcile lane. Forcing eviction of hot entries would cause chart re-fetch churn. Not changed. |
| Control arm records weaker staleness — contamination | **OVERSTATED** | The control arm carries no DEX features, so `dex_stale` would flag data it does not hold. Both arms already recorded the `sol_price_*` flags that matter. Unified anyway via `snapshotStaleFlags()` for shape parity, but as hygiene, not a contamination fix. |
| `events` table holds ~2.9 M rows | **STALE** | Live table holds ~20 k. `EVENT_RETENTION_DAYS=7` prunes it; 2.9 M is what a June *dump* contains. This materially lowers the severity of the unbounded-query findings below. |

---

## Fixed in this pass

| Item | Fix |
|---|---|
| `ts_source` labelled local timestamps as `chain` | Provenance decided in the parser where the fallback happens, carried on `ParsedPumpEvent`, read verbatim by `eventToRow`. `parseProgramLogs`/`parseSwapLogs` default to `"local"` (fail-closed). |
| Two `EXTRACT(EPOCH …)` sites returned strings | `::float8` added (`engine-a-baseline.ts:170`, `engine-b-compare.ts:73`). |
| `restore-test.ps1` passed a schema-only dump | `TryParse` now writes to a real variable; 0 rows fails. |
| No final halt gate before paper execution | `haltedNow()` immediately before both `executePaperBuy` sites; fails closed if the breaker cannot be read. |
| HALT retired the session before exits ran | Final `handleExits()` pass before `stopSession()`. |
| `quick-start` could create a live session without the full gate | Requires `isLiveAllowed()`. |
| `prepare-sell` bypassed breaker + live confirm | Calls `assertLiveExecutionAllowed()`. |
| `LIVE_DRY_RUN=on` still built a signable Phantom tx | Refuses to build one. |
| `worker:unlock` terminated every advisory-lock holder | Filters on our key in our database; staleness from `WORKER_HEARTBEAT_TIMEOUT_MS`. |
| `wallet/create` + `wallet/import` ungated | Behind `WEB_WALLET_SESSION`, matching unlock/lock/wipe/status. |
| Silent ingest data loss | `eventsDropped` on `IngestorStats`, `/api/stats/ingestor` and the periodic log. |
| Four caches with no eviction | `BoundedMap`/`BoundedSet` applied to `priorSnapshots` (2,000), `tradeCounters`/`epochBumpedMints` (5,000), `curveCandlesCache` (500). |
| `/api/trades/export` unbounded | Per-source `LIMIT`, clamped to 50,000, default 10,000. |
| `quality.ts` ignored the runtime signal-mode override | Accepts an explicit `signalMode`; all 5 server call sites pass `getEffectiveSignalMode()`. |
| Only p50/p95, only on reaction time | p50/p90/p95/p99/max, plus an `execLatency` companion, exposed on `/api/auto/session-insights`. |

---

## Open, not addressed

| Item | Why deferred |
|---|---|
| Live/paper exit parity (trailing stop, stagnation, `markPnl`) | Needs peak persistence on `live_trades`, which has no `entry_features` updater — new write surface on the real-money ledger. Missing trail makes live exit *earlier*, i.e. conservative, so it is a fidelity gap not a hazard. |
| Live stale-price hang (`current == null` → `continue`) | The paper fix force-closes at last mark; that is pure bookkeeping. A live position is real tokens on-chain, so marking it closed without selling desyncs ledger from chain. Suggested path: flag via the existing `markLivePositionCloseFailed` / `fetchLivePositionsNeedingAttention` mechanism. **Needs an operator decision.** |
| `/api/backtest/run` N+1 | Up to 8,000 sequential `events` queries per request, no auth, no rate limit (`lib/backtest/runner.ts:361`). Lower severity now that `events` is ~20 k rows, but still unguarded. |
| Full stage telemetry (T0–T9) | `receivedAt`/`decodedAt` are not carried to trade time; plumbing them crosses the ingest→commit→trade boundary. `ts_source` (this pass) is a prerequisite for trusting any of it. |
| Migrations have no `down` | Recovery is restore-from-dump, which `safe-migrate.ps1` supports properly. |
| `runMigrations` has no advisory lock | Every API route calls `bootDb()`, so the web tier is also a migration runner; `already exists` errors are swallowed. `pnpm build` is safe; `pnpm dev`/`start` concurrent with the worker are not. |
| `confirm-live` trusts client-reported size | `sizeSol`/`entryVSol` from the request body are written to the live ledger without on-chain reconciliation. Live-phase work. |

---

## Frontend rebuild (2026-09-06)

The 17-route, ~14,200-line frontend was replaced by three screens (`/` chooser, `/trade`
terminal, `/wallet`) fed by one endpoint, `/api/ticker`. Everything below was removed **after**
the chart worker lanes had been disabled and the runtime measured for a 5-minute window each way.

### Measured: chart lanes ON vs OFF (5-minute windows, same script)

| Metric | Lanes ON | Lanes OFF |
|---|---|---|
| DB transactions / s | 417 | 79 |
| Postgres CPU (two samples) | 129% · 138% | 34% · 78% |
| DB active time | 58.6% | 50.1% |
| Worker CPU (share of one core) | 16.5% | 9.8% |
| `chart-aggregator` duty | 338–382 ms of every 600 ms tick | — |
| decision→intent p50 (trades opened in-window) | 51.5 s (n=2) | 29.8 s (n=5) — **inconclusive**, sample too small |

The lanes were ~81% of DB transactions and ~40% of worker CPU whether or not a browser was
open. Their effect on entry latency is **not** established by this data. `pg_stat_statements`
is not installed (needs a Postgres restart), so this rests on `pg_stat_database` /
`pg_stat_user_tables` deltas and process CPU.

### Removed

- Pages (13): `/analytics /backtest /diagnostics/runtime /learning /market /mission /notifications /paper /rings /runtime /signals /smart-money /token/[mint]`.
- `lib/chart/**`, `components/chart/**`, the six `lib/workers/chart-*` lanes, the chart WebSocket server, `lightweight-charts`, and the `CHART_WS_PORT` / `NEXT_PUBLIC_CHART_WS_URL` env keys.
- 44 components and 13 orphaned `lib/ui`, `lib/mission`, `lib/pump`, `lib/hooks` helpers.
- 31 API routes whose only consumers were deleted pages, including `/api/backtest/run` (the unguarded N+1 above).

### Preserved on purpose

- `lib/chart/data/dexPool.ts` → `lib/dex/dex-pool.ts`, `lib/chart/data/onchainPrice.ts` → `lib/dex/onchain-price.ts`: graduated-position mark-to-market for stop-loss/take-profit. Not chart code.
- `PUMP_SUPPLY` → `lib/pump/program.ts`; `TrenchCoin` type → `lib/market/types.ts` (the worker's trend-scanner reaches it through `lib/market/discovery`).
- Seven operator routes with no UI consumer, kept because they are curl-able instruments: `/api/auto/status`, `/api/auto/log`, `/api/auto/diagnostics`, `/api/auto/session-insights` (the latency percentiles), `/api/trades/export` (tax CSV), `/api/settings/limits` (only runtime path to live caps).
- The three chart tables (13.6 MB). Dropping them is a separate migration.

### Still open after the rebuild

| Item | Note |
|---|---|
| Sparkline history is per-tab | Client ring buffer (600 samples, `sessionStorage`). No server-side unrealized-P&L history exists. |
| `lib` modules now with zero importers | `lib/api/token-bundle.ts`, `lib/backtest/learn.ts`, `lib/continuation/eval-mints-public.ts`, `lib/continuation/missed-report.ts`, `lib/db/repos/token-snapshot.ts`, `lib/ingest/helius-pumpswap-stub.ts`, `lib/intelligence/transition-replay.ts`, `lib/phantom/usePhantomLiveTrade.ts`, `lib/workers/decision.ts`. Not deleted — not frontend. |
| Pre-existing dead API routes | Had no consumer before the rebuild either: `/api/auto/start /api/bots/flags /api/continuation/compare /api/continuation/eval /api/creates/live /api/dex/embed /api/events/recent /api/intelligence/evaluate /api/nav/status /api/paper/history /api/paper/reset /api/paper/snapshot /api/runtime/postgres /api/tokens/top /api/watchlist`. Left alone. |
| Single Sell on a graduated coin | Demo sells price off the frozen curve; the row passes its mcap-derived `currentVSol` as the route's hint, so it works — but only because the hint exists. |
| Historical docs | `SYSTEM_DESIGN.md`, `ARCHITECTURE*.md`, `PROJECT_STATUS.md`, `LOCALHOST_PROFILE.md` still describe the chart system and deleted pages as design history; `README.md` and `operations.md` are current. |

## Fabricated closes in `domain_events` (do not mine these as wins)

Before the price-basis fix (`lib/paper/close-price.ts`), two force-close paths —
`session_ended` in `sweepOrphanedOpenPositions` and `timeout_stale` — closed positions at the raw
stored `current_price`. For a graduated coin that value is on the **mcap-derived** basis
(`effectiveVSolFromMcapUsd`), while `entry_price` is on the **bonding-curve** basis. Paper P&L is
`(exit/entry)² − 1`, so a 10× basis error became a 100× fake profit.

Four closes are affected. The positions themselves were removed by later demo resets, but the
events remain — `domain_events` is an audit trail and is deliberately left intact:

| position | reason | booked pct | booked SOL |
|---|---|---|---|
| 1252 | `session_ended` | +85,749% | +68.599 |
| 1251 | `session_ended` | +27,537% | +27.537 |
| 1289 | `session_ended` | +11,115% | +26.676 |
| 1249 | `session_ended` | +1,169% | +1.169 |

**None of this ~+124 SOL was ever real.** The same artifact inflates the 2026-06-02 session
remembered as +49.9 SOL (average +501% per trade). Any analysis over `PAPER_TRADE_CLOSED` should
filter `abs((payload->>'pctOfSize')::numeric) > 1.0` when looking at history from before this fix.
