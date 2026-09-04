# sol-pump-radar — Complete System Design & Developer Handoff

> **Audience:** the next developer, inheriting this project cold.
> **Goal:** everything you need to operate, extend, and debug the system without asking the
> original author. Every formula, threshold, and data path below is taken directly from the code
> (file paths cited inline). When code and this doc disagree, the code wins — fix the doc.

> **What it is:** a **localhost-only**, single-operator Solana **pump.fun** analytics + **paper-first**
> (optionally live) automated trading system. It ingests pump.fun bonding-curve trades and DEX
> (PumpSwap) market data in real time, scores coins through a multi-engine decision pipeline,
> auto-trades them (paper or live), renders real-time charts, and learns from its own outcomes.

---

## Table of contents

1. Tech stack
2. Process architecture & the web↔worker boundary
3. Repository layout (every directory)
4. Configuration (every env var)
5. Data ingestion — how data enters the system
6. Data model (Postgres tables)
7. The decision pipeline — overview
8. Engine A (launch / newborn) — exact logic
9. Engine B (continuation / post-graduation) — exact logic
10. Engine fusion — picking the winner
11. The analytics modules M1–M5 — exact formulas
12. The three-gate copy-trade judge — exact formulas
13. The commit authority — what becomes a tradable decision
14. The auto-trader — entries, exits, risk
15. The entry filter — the final veto layer
16. Risk presets & position sizing
17. Exit decision logic
18. The chart subsystem
19. The learning loop
20. Live execution & the wallet vault
21. How the user interacts (UI + API surface)
22. Worker lanes — full enumeration & cadence
23. Security model
24. How to run / operate / test
25. Runbook — known failure modes & fixes
26. Database reference (every table & column)
27. Frontend reference (pages, components, client data flow)
28. Per-file index (every `lib/` file)

---

## 1. Tech stack

| Layer | Choice |
|---|---|
| Language | TypeScript (strict), Node ≥20, ESM |
| Package mgr | pnpm 9 workspace (monorepo) |
| Web | Next.js 15 (App Router, React 19) — UI + read API + gated writes |
| Styling | Tailwind CSS 3 + PostCSS |
| Charts | TradingView **lightweight-charts 5.2** |
| Client state | Zustand 5 + React hooks; SSE + polling |
| DB | **Postgres 16** (Docker), **Drizzle ORM** 0.36 + raw `pg` Pool; `drizzle-kit` migrations |
| Realtime/RPC | `ws` (WS server :8788 + Helius `logsSubscribe`), raw JSON-RPC to Helius |
| Solana | `@solana/web3.js`, `bs58`, custom Borsh/Anchor decoders |
| Wallet | `@phantom/react-sdk` (browser live), Node `crypto` AES-256-GCM + scrypt vault (worker) |
| Validation | Zod (env + payloads) |
| External data | Helius RPC/WS, DexScreener REST, GeckoTerminal OHLCV, pump.fun API, CoinGecko, Binance |
| Tests | `node:test` + `tsx` (`*.test.ts` colocated) |
| Process mgmt | Docker Compose (Postgres); two Node processes (`pnpm dev`, `pnpm worker`) |

**Workspace packages** (`packages/`):
- **`@spr/db`** — `Pool`/Drizzle connection (`connect.ts`), migration runner, and **`executeWebMutation`** (the only sanctioned web-write path; `web-writes.ts`).
- **`@spr/core`** — durable event log (`appendEvent`/`replay`/`summarizeReplayTail`), trade **FSM**, reconciliation, metrics.
- **`@spr/trading`** — pure trading kernel: paper `executor`, `portfolio`, `pnl`, `pricing`, `risk`, `slippage`, `state-machine`. Deterministic, framework-agnostic.

---

## 2. Process architecture & the web↔worker boundary

```
┌────────────────────┐     domain_events (command bus)      ┌──────────────────────────┐
│  Next.js (pnpm dev)│ ───────  *_REQUESTED  ───────────▶  │  apps/worker (pnpm worker)│
│  :3000             │ ◀──────  *_COMPLETED / *_REJECTED ── │  the ONLY automation rt   │
│  UI + read API +   │                                      │  ~25 setInterval lanes +  │
│  GATED writes      │            shared Postgres :5432     │  WS server :8788 + Helius │
└────────────────────┘ ◀──────────────────────────────────▶└──────────────────────────┘
                                   sole durable truth
```

**The single most important invariant:** *Next.js never runs automation.*
- `instrumentation.ts` is deliberately inert (records a perf note only; does **not** boot workers or DB).
- `lib/workers/orchestrator.ts` throws if imported under `process.env.NEXT_RUNTIME` — a hard guard so an accidental import from an API route fails fast instead of silently spawning a second ingestor.
- The worker is **singleton-guarded** (`lib/runtime/worker-lock.ts`): only one `pnpm worker` can hold the lock. A second instance exits.

**Why two processes share one DB:** Postgres is the sole durable truth. The worker is the **single writer** of trading state. The web tier can only *request* state changes, never perform them directly:

`executeWebMutation(op, fn)` (`packages/db/src/web-writes.ts`) accepts only an **allowlisted op** and runs `fn` in a transaction. The complete op vocabulary the web can issue:

```
PAPER_RESET_REQUEST  DEMO_RESET_REQUEST  SETTINGS_MODE  SETTINGS_SIGNAL_MODE
SETTINGS_LIMITS  AUTO_SESSION_START  AUTO_SESSION_STOP  CIRCUIT_BREAKER
LEARNING_RULE_STATUS  PHANTOM_LIVE_RECORD  PAPER_TRADE_INTENT
LIVE_TRADE_INTENT  LIVE_SELL_INTENT
```

Wire protocol on `domain_events.type`: `*_REQUESTED` (web enqueues) → worker's **`web-command-listener`** (and the dedicated `live-execution-listener`, `paper-trade-listener`, `demo-reset-listener`, `phantom-live-listener`) consumes → `*_COMPLETED` / `*_RECORDED` (success) or `*_REJECTED` (refused, reason in payload). So a "Start auto session" button writes `AUTO_SESSION_START_REQUESTED`; the worker validates and writes the `auto_sessions` row + `*_COMPLETED`.

---

## 3. Repository layout (every directory)

```
app/        Next.js App Router — 14 pages + ~95 API routes (§21)
components/ 87 React components (chart/, trade UI, mission control, wallet…)
lib/        325 files — the core (table below)
apps/worker src/main.ts → boots DB, vault, orchestrator + standalone lanes
packages/   @spr/db, @spr/core, @spr/trading
drizzle/    28 SQL migrations (applied at worker boot via lib/db/migrate)
scripts/    16 CLI tools (session:report, e2e, eval, validate, worker:unlock…)
docs/       design docs (this file, ARCHITECTURE, DUAL_ENGINE, CONTINUATION, ENGINE_B, SECURITY…)
types/, data/, drizzle.config.ts, docker-compose.yml, next.config.mjs, instrumentation.ts
```

### Every `lib/` domain

| Domain | Role / key files |
|---|---|
| **`workers/`** | The automation lanes (§22): `orchestrator`, `ingestor`, `analytics`, `auto-trader`, `intelligence-commit`, `continuation-universe`, `continuation-event-stream`, `bot-detector`, `clusterer`, `rug-labeler`, `shadow-learner`, `trend-scanner`, `missed-winner-scan`, `retention`, `continuation-learner`, `learner`, `notifier`, `decision`, `trader` (legacy), the 5 chart lanes, and the 5 web-command listeners |
| **`intelligence/`** | The decision brain: `dual-engine` (orchestrates), `engine-router` (A vs B), `engine-a-launch`, `engine-fusion`/`engine-fusion-core`, `commit`/`commit-policy-core` (decision authority), `auto-gate`/`auto-gate-core`, `gate-config`, `regime`, `launch-hot/rank/velocity`, `eval-scheduler`, `state-delta-detector`, `bundle-cache`, `hot-mints`, `pnl-attribution`, `scored-mint-adapter`, `normalized-adapter`, `intelligence-jsonl` |
| **`continuation/`** | Engine B internals: `engine-b`, `score`, `momentum-state`, `probability`, `fusion`, `leading-signals`, `archetype`, `cross-mint-rank`, `state-registry`, `state-transition-alerts`, `detection-timing`, `stages`, eval/replay/trace harness |
| **`modules/`** | `m1-graduation`, `m2-insider`, `m3-rug`, `m4-creator`, `m5-wash` — the analytics module scores |
| **`intel/`** | `three-gate` (wallet/coin/timing), `insider-tracker`, `imitation`, `union-find` (wallet clustering) |
| **`paper/`** | Paper engine: `engine` (paperOpen/Close/PartialClose), `exit-decision`, `math`, `mcap-pnl`, `curve-pnl`, `mtm-lane`, `price-resolver`, `sell-helpers`, `read`/`ui-positions`, `reset-listener` |
| **`executor/`** | `paper`, `live`, `live-phantom`, `micro-sim` (slippage sim), `exec-normalize`, `normalizer` |
| **`trade/`** | `entry-filter` (final veto), `opportunities-lite`, `tier-control`, `tradeable`, `timing-age`, `bootstrap-data` |
| **`risk/`** | `presets`, `position-sizing`, `kill-switch` |
| **`chart/`** | `data/` (candleBuilder, geckoOhlcv, onchainPrice, ingestBridge), `runtime/` (chartRuntime, chartWsServer), `engine/`, `realtime/` |
| **`dex/`** | `market-snapshot`, `snapshot-cache`, `curve-mcap` (vSol↔mcap math), `discovery`, `normalizer`, `embed` |
| **`pump/`** | `parser` (Borsh decode), `program` (program IDs), `fun-api`, `resolve-price`, `trenches-cache` |
| **`rpc/`** | `ws-manager` (reconnect/backoff), `borsh`, `anchor`, `stats` |
| **`db/`** | `client` (bootDb/getDb), `schema/` (20 files), `repos/` (28 files), `migrate`, `write-queue`, `retention`, `paper-read` |
| **`market/`** | `discovery`, `enrich-mints`, `flags`, `sol-usd` (cached SOL/USD) |
| **`wallet/`** | `crypto` (AES-256-GCM + scrypt), `worker-vault`, `session`, `holdings`, `balance`, `storage`, `copy-trade-safety` |
| **`runtime/`** | `mode-authority`, `web-writes`, `worker-lock`, `worker-heartbeat-db`, `runtime-snapshot`, `live-guards`, `queue-command`, `with-route-perf` |
| **`circuit-breaker/`** | `state` (HALT/resume) |
| **`tuner/`, `settings/`** | `limits` (clamp helpers), `signal-mode`, `mode-lite` |
| **`signals/`, `arch/`, `phantom/`, `backtest/`, `gmgn/`, `mission/`, `api/`, `ui/`, `hooks/`, `shared/`, `ingest/`** | signal quality; in-process event-bus; Phantom live; backtest runner; GMGN rank; mission-control provider; API helpers; client utils/hooks; shared types; helius-pumpswap stub |

---

## 4. Configuration (every env var)

All config is validated once by **Zod** in `lib/env.ts` (`env()` is cached; bad config throws at first call). `.env.local` (gitignored, real secrets) overrides `.env.example` (tracked, placeholders). A `RUNTIME_PRESET` bundle (`paper_safe`/`paper_aggressive`/`live_safe`/`live_aggressive`) fills defaults that explicit vars still override.

| Var | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | `postgresql://sol:sol@127.0.0.1:5432/solpump` | Postgres DSN |
| `RPC_HTTP_URLS` / `RPC_WSS_URLS` | public mainnet | comma-list; **Helius key prepends a low-latency endpoint** |
| `HELIUS_API_KEY` | "" | when set, `rpcHttpUrls()`/`rpcWssUrls()` put Helius first |
| `TRADER_MODE` | `paper` | paper / devnet / live |
| `RISK_PRESET` | `balanced` | conservative / balanced / aggressive (presets §16) |
| `SIGNAL_MODE` | `hybrid` | **launch** (sniper) / **profit** (continuation) / **hybrid** (both). UI-overridable at runtime via `user_settings`; orchestrator refreshes every 8s |
| `RUNTIME_PROFILE` | `paper_safe` | **paper_safe** (no live tx) / **dev** (devnet) / **live** (mainnet real money) |
| `LIVE_EXECUTION` | `off` | master live switch |
| `LIVE_DRY_RUN` | `on` | simulate live tx without sending |
| `LIVE_CONFIRM` | "" | must equal `I_UNDERSTAND_REAL_MONEY` to fire real money (else `env()` throws) |
| `LIVE_MAX_PER_TRADE_SOL` | `0.05` | per-trade cap |
| `LIVE_MAX_DAILY_SOL` / `LIVE_MAX_DAILY_LOSS_SOL` | `5` / `0.5` | daily caps |
| `LIVE_MAX_CONSECUTIVE_LOSSES` | `3` | kill-switch threshold (live) |
| `LIVE_SLIPPAGE_BPS` / `LIVE_PRIORITY_FEE_SOL` | `500` / `0.0005` | execution params |
| `VAULT_PASSPHRASE` | "" | worker auto-unlocks the wallet vault at boot when set. **Never read/send from web.** |
| `WALLET_AUTO_LOCK_MINUTES` | `30` | auto-lock idle wallet |
| `WEB_WALLET_SESSION` | `off` | keep off for worker-only live arch |
| `INTELLIGENCE_TICK_MS` | `3000` | commit lane cadence |
| `INTELLIGENCE_UNIVERSE_MAX` | `150` | max active mints scored |
| `INTELLIGENCE_SKIP_UNCHANGED_MS` | `35000` | skip re-eval when signal/state/rank unchanged |
| `INTELLIGENCE_TOP_RANK` | `20` | always-eval top-N by rank |
| `INTELLIGENCE_MAX_EVAL_PER_TICK` | `60` | priority-queue eval cap |
| `INTELLIGENCE_MAX_COMMITS_PER_TICK` | `12` | batched decision_log insert cap |
| `INTELLIGENCE_BUNDLE_TTL_MS` | `10000` | commit input bundle cache |
| `LAUNCH_HOT_*` | various | newborn fast-lane thresholds (minVSol 2, minTrades 1, minWallets 2, minGates 2, minScore 0.45, ttl 18s) |
| `PAPER_START_SOL` | `10` | paper account balance |
| `PAPER_MAX_OPEN_POSITIONS` | `3` | global paper concurrency |
| `PAPER_MAX_POSITION_SOL` | `0.25` | per-trade cap (paper) |
| `PAPER_DAILY_LOSS_LIMIT_SOL` | `1` | paper daily loss cap |
| `PAPER_MARK_TO_MARKET_MS` | `10000` | MTM lane cadence |
| `PAPER_ENABLE_SLIPPAGE/FEES/LATENCY` | `on` | realism toggles |
| `AUTO_DEMO_RELAX` | `on` | looser entry gates for paper/demo so sessions actually open |
| `AUTO_CONTINUATION` | `off` | Engine B alerts opt-in |
| `AUTO_TUNE` | `off` | learner auto-applies tuning changes |
| `SHADOW_LEARNER` / `SHADOW_LEARN_SIZE_SOL` | `off` / `0.03` | background paper trades to grow dataset |
| `MAX_ENTRY_MCAP_USD` | `0` (off) | launch/hybrid: skip auto-entries above this real DEX mcap |
| `ACTIVE_MINT_WINDOW_MINUTES` | by mode (launch 15 / hybrid 180 / profit 240) | analytics window |
| `CONTINUATION_*` | various | Engine B score floors & probability gates (alertScore 0.38, buyScore 0.52, P_breakout_buy 0.8, P_exhaustion_block 0.7…) |
| `CHART_WS_PORT` / `NEXT_PUBLIC_CHART_WS_URL` | `8788` / `ws://127.0.0.1:8788/chart` | chart WS |
| `MAX_INGEST_QUEUE` | `5000` | ingest backpressure buffer |
| `EVENT_RETENTION_DAYS` | `7` | events table retention |
| `LEGACY_TRADER` | `off` | old single trader lane |
| `DISCORD_WEBHOOK_URL`, `TELEGRAM_BOT_TOKEN/CHAT_ID`, `NOTIFY_MIN_PNL_SOL` | — | notifications |

**Cross-field guard:** if `LIVE_EXECUTION=on` and `LIVE_DRY_RUN=off`, then `RUNTIME_PROFILE` must be `live` **and** `LIVE_CONFIRM=I_UNDERSTAND_REAL_MONEY`, or `env()` throws at boot. `isLiveAllowed()` requires all three.

---

## 5. Data ingestion — how data enters the system

| Source | Mechanism | Feeds |
|---|---|---|
| **Helius WS** `logsSubscribe` | `lib/rpc/ws-manager` subscribes to `PUMP_BONDING_CURVE_PROGRAM`; `lib/pump/parser` Borsh-decodes Trade/Create/Complete events | `ingestor` lane |
| **Helius RPC** JSON-RPC | `getAccountInfo`/`getMultipleAccounts` (pool reserves), `getSignaturesForAddress` | on-chain live price (`chart/data/onchainPrice`), wallet balances |
| **DexScreener REST** | `dex/market-snapshot` (batched, cached ~12s in `snapshot-cache`) | continuation universe, `dex_features`, pool addrs, fallback price, **entry order-flow** |
| **GeckoTerminal OHLCV** | `chart/data/geckoOhlcv` (cached, rate-limit aware, 30 req/min) | dense post-graduation DEX candles |
| **pump.fun API** | `pump/fun-api` (`fetchPumpFunCoin`) | graduation %, `usdMarketCap`, vSol, complete flag |
| **CoinGecko / Binance** | `market/sol-usd` | SOL/USD for all mcap math (refreshed every 60s by orchestrator) |

**Ingestor lane (`lib/workers/ingestor.ts`) — the hot path:**
1. `WsLogsSubscriber` receives a log notification (auto-reconnect with backoff on drop).
2. `parseProgramLogs(logs, sig, slot, unixSec)` → `ParsedPumpEvent[]` (buy/sell/create/complete). Decode failures increment `stats.decodeErrors`, never throw into the WS callback.
3. Events buffer in memory. **Flush trigger:** `buffer.length >= 100` (FLUSH_BATCH_SIZE) OR a 500ms timer (FLUSH_INTERVAL_MS).
4. **Backpressure:** if `buffer.length + parsed > MAX_INGEST_QUEUE` (5000), drop and emit a batched `INGEST_DROPPED` audit every 100 drops.
5. `flush()` order (core truth first, never blocked by side-paths): `insertEvents(batch)` → `ingestChartEventsFromBatch` (push to chart) → `upsertNewTokens` (for `create` events) → `processLaunchHotPipeline` (newborn fast-lane) → `insertIngestFacts` (dedupe audit) → emit `ingest:flush` on the in-process `event-bus`.

**Important nuance:** most *traded* coins are DexScreener-discovered (already graduated) and have **no** trade-level rows in `events`. For those, the bonding-curve flow query is blind and DexScreener 5m aggregates are the only order-flow signal (used at entry — §14).

---

## 6. Data model (Postgres, by domain)

Schema lives in `lib/db/schema/*.ts` (20 files); repos in `lib/db/repos/*.ts` (28 files). Migrations in `drizzle/` apply at worker boot.

- **Ingest & market truth:** `events` (every buy/sell/create/complete; `v_sol_after`, wallet, sig, slot — primary on-chain truth), `tokens`, `mint_registry`, `pool_registry`, `trend_candidates`, `parse_errors`, `ingest_facts`
- **Features / intelligence:** `token_features` (5m flow, momentum, RSI, extras JSONB), `wallet_features`, `creator_features`, `dex_features` (DexScreener 5m aggregates), `decision_log`, `decision_trace`, `engine_b_traces`, `normalized_snapshots`, `continuation_candidates`, `continuation_events`, `gate_stats`
- **Trading:** `paper_positions` (THE single paper ledger; `state` OPEN/CLOSING/CLOSED, `entry_price`=entry vSol, `entry_features` JSONB carries session_id/gates/peak_pct/mcap/exec metrics, `close_reason`, `realized_pnl_sol`), `live_trades`, `trade_outcomes`, `signal_outcomes`, `auto_sessions`
- **Bots / clustering:** `mint_bot_flags` (bundle/sniper/bump/mechanicalUptrend), `wallet_profiles` (t_stat/avg_return/sniper_rate/bundle_rate/is_bump_bot), `clusters`/`cluster_members`/`wallet_edges`, `rug_labels`
- **Learning / tuning:** `loss_postmortems`, `learned_rules`, `tuner_changes`
- **Chart:** `chart_stream_state`, `mint_dex_quotes`, `chart_candle_checkpoints`
- **Runtime / ops:** `domain_events` (command bus + durable event log), `user_settings`, `wallets_local`, `notifications`, `cb_events`, `rpc_health`, `dead_letters` (**reserved — schema only; no writer and no reader exist**, see `docs/codebase-cleanup.md`)

`PAPER_TRADES_READ` is a SQL view over `paper_positions` (entry_price=entry_v_sol, current_price, stop_loss, take_profit, close_reason=exit_reason) used by read APIs.

---

## 7. The decision pipeline — overview

```
Collectors: ingestor (WS) + DexScreener poll + analytics modules M1–M5
   ↓ writes token_features / dex_features / mint_bot_flags / rug_labels
continuation-universe (30s): builds normalized snapshots + cross-mint rank table
   ↓
intelligence-commit (3s, BOUNDED priority queue — NOT the whole universe):
   getCommitInputBundle (cached 10s) → cross-mint ranks → delta/trigger events
   → planMintsToEvaluate (top-rank + changed + hot, capped at 60/tick)
   → for each mint:  selectEngine → Engine A or B → fuseEngineIntelligence
   → planIntelligenceCommit (cooldown, material-change, persist policy)
   → prioritizePlannedCommits (cap 12/tick) → flushIntelligenceCommits
   ↓ decision_log + decision_trace + intelligence JSONL + emit intel:committed
auto-trader (3s): consumes pending BUY decisions → entry-filter → paperOpen / live intent
   ↓
paper_positions / live_trades  → outcomes → learner
```

`fuseEngineIntelligence` (`engine-fusion.ts`) runs the routed engine, wraps it in `FusionMeta`, and is the single evaluation entry point. `evaluateMintIntelligence` (`dual-engine.ts`) is the pure "god function" — no DB writes.

**Engine routing** (`engine-router.ts`): curve-stage + Engine-A-eligible → **A**; else Engine-B-eligible → **B**; else fall back. (`normalized-adapter.ts` defines eligibility.)

The commit lane also classifies the **market regime** each tick (`regime.ts`: rug-heavy / thin / normal) from the universe stats and tightens/loosens the gate config and position size accordingly.

---

## 8. Engine A (launch / newborn) — `lib/intelligence/engine-a-launch.ts`

Engine A scores **fresh bonding-curve launches**. It is intentionally permissive on liquidity/age (a newborn can't satisfy mature-token floors) but demands real *launch velocity* and hard anti-rug.

**Step 1 — `computeLaunchState(input)`** assigns a softmax-style confidence over 4 states `{cold, launching, early_breakout, acceleration}`:
- base `{0.2, 0.15, 0.1, 0.08}`; `cold` → 0.8 if `liquidity_usd < 4000` else 0.05
- `launching += 0.45` if `is_new_pool || age < 300s`
- `early_breakout += 0.4` if `volume_m5 > volume_m30*0.25 && price_change_m5 > 5`
- `acceleration += 0.5` if `price_change_m5 > 12 && price_change_h1 > 8 && buy_sell_ratio > 0.55`
- crowd bonus: `unique_wallets_5m > 12 && holder_growth > 0.1` → `early_breakout += 0.25, acceleration += 0.2`
- normalize, pick argmax → `{state, confidence}`.

**Step 2 — launch-velocity** (`scoreLaunchVelocity`, `launch-velocity.ts`): a "sustained-liquidity predictor" from vSol delta, unique buyers, buy/sell ratio, price impulse, with hard vetoes — `rugFingerprint`, `bundleLaunch`, and `singleWalletLaunch` (`unique_wallets_5m <= 1`, i.e. only the creator). `minVSol = max(1, engineA.liqFloorUsd)`.

**Step 3 — `resolveEngineASignal`** (gated by mode config `cfg = ctx.gateConfig` — §gate-config):
- `AVOID` if `liquidity_usd < liqFloorBaseUsd` OR `risk.rug` OR `risk.rapid_sell_pressure` OR `risk.bundle` OR `risk.insider`.
- `vol2x = volume_m5 >= (volume_m30/6)*2`; `velocityOk = velocityScore >= engineA.velocityFloor`.
- **`BUY_STRONG`** if `state ∈ allowStates && liquidity_usd >= engineA.liqFloorUsd && vol2x && velocityOk && rank >= engineA.rankFloor`.
- **`BUY_MODERATE`** if `(early_breakout|launching) && 0.6 <= rank < 0.8`.
- else `WATCH`.

**Step 4 — `engineAAutoAllowed`** (can this auto-trade?): signal is BUY_STRONG (or BUY_MODERATE when `allowModerateAuto`), state in allowStates, `rank >= rankFloor`, `liquidity_usd >= liqFloorUsd`, `velocityScore >= velocityFloor`, no rug/bundle/insider, and not a curve-stage migration event. Sets `auto_trade_allowed` on the output.

`confidence = clamp01(stateConfidence + eventImpulse*0.1)`. `miss_type` classifies *why* a non-buy happened (NOT_IN_UNIVERSE / LOW_RANK / EVENT_MISSED / NO_STATE_TRANSITION…) for the missed-winner analysis.

### Gate config per mode — `lib/intelligence/gate-config.ts`

Engine A floors come from a mode-keyed config (no more hard-coded literals that biased toward mature tokens). The learner can override each within a clamped band (`resolveGateConfig`).

| Mode | liqFloorBase | A.liqFloor | A.rankFloor | A.velocityFloor | A.allowStates | A.moderateAuto | B.rankFloor | B.maxExtension |
|---|---|---|---|---|---|---|---|---|
| **launch** | 1,500 | 1,500 | 0.50 | 0.40 | launching, early_breakout, acceleration | yes | 0.85 | 300% |
| **hybrid** | 2,000 | 3,000 | 0.55 | 0.38 | launching, early_breakout, acceleration | yes | 0.85 | 300% |
| **profit** | 8,000 | 20,000 | 0.80 | 0 | early_breakout, acceleration | no | 0.85 | 300% |

---

## 9. Engine B (continuation / post-graduation) — `lib/continuation/engine-b.ts`

Engine B scores **graduated coins with momentum** (the "ride the runner" engine). Pure pipeline:

1. `leadingScore = computeLeadingScore(snapshot, prior)` — early-momentum precursor.
2. `posterior = computeStatePosterior(snapshot, {leadingScore, rankVelocity})` → distribution over momentum states; `dom = dominantState(posterior)`.
3. Components: `rankMomentum = rankMomentumFromPercentile(rankPercentile)`, `velocityScore(rankVelocity)`, `stateConfidence`, `liquidityQuality(snapshot)`, `eventImpulse` (clamped ≤1), `leadingScore`.
4. `probabilities = computeProbabilities(...)` → `{breakout, exhaustion, ...}`.
5. `continuationScore = computeScoreB(components)` (weighted blend, `fusion.ts`).
6. `applyProbabilityGates({scoreB, rankPercentile, dominantState, probabilities})` → gated action + `gateFlags` (`blockedByExhaustion` / `blockedByLowBreakout` / `cappedByParabolic`). Thresholds from `envContinuation()`: alertScore 0.38, buyScore 0.52, P_breakout_buy 0.80, P_breakout_alert 0.65, P_exhaustion_block 0.70.
7. State-transition overrides: `applyIntrinsicEarlyEntry` + `applyTransitionActionOverride(priorState, …)` (a fresh transition into a strong state can upgrade the action).

Output `EngineBResult` carries state, posterior, ranks, score, probabilities, action, and `components` (full transparency for the trace). `engineBAsync` also persists an `engine_b_traces` row. The thin wrapper `scoreContinuation` (`score.ts`) rejects `weightedLiqUsd < 8000` up-front and maps actions to `CONTINUATION_BUY`/`DEX_TREND_ALERT`/`WATCH`/`EXHAUSTION_WARNING`/`SKIP`.

**Engine B auto-allow** (`auto-gate-core.ts`): only `CONTINUATION_BUY` + state `acceleration` + `rank >= engineB.rankFloor` (0.85) + `price_change_h1*2 <= maxExtensionPct` (300%) + (has trigger events OR confidence ≥ 0.45).

---

## 10. Engine fusion — `lib/intelligence/engine-fusion-core.ts`

When both engines produce a candidate, the winner is chosen by **signal priority + early-state bonus**:

```
SIGNAL_PRIORITY: BUY_STRONG 100, CONTINUATION_BUY 95, DEX_TREND_ALERT 85,
                 BUY_MODERATE 80, EXHAUSTION_WARNING 40, WATCH 30, AVOID 20, NONE 0
EARLY_STATES bonus (+15): launching, early_breakout, acceleration, trend
```

Tie-break: priority+bonus → confidence → rank_percentile. `fuseMissTypeCore` propagates a miss_type only when the winner is NONE/WATCH. No candidates → synthetic `NONE` with `miss_type = NOT_IN_UNIVERSE`.

---

## 11. The analytics modules M1–M5 — `lib/modules/`

Each returns a score in `[0,1]` with human reasons. The **analytics** lane computes them per active mint and stores them in `token_features`; they surface as `moduleScores` keys (`M1_GRADUATION`, `M2_INSIDER`, `M3_RUG`, `M4_CREATOR`, `M5_WASH`).

**M1 graduation (`m1-graduation.ts`)** — *higher = better.* `PUMP_GRADUATION_V_SOL = 85`.
`score = 0.35·curveProgress + 0.30·velocity + 0.20·breadth + 0.10·pressure + 0.05·age`, where curveProgress=`vSol/85`, velocity=`sat(Δ5m vSol, 12)`, breadth=`sat(uniqueBuyers5m, 30)`, pressure=`(buys−sells)/total/2 + 0.5`, age weighted to a 5–15min prime window. A `scoreGraduationContinuation` variant re-weights toward velocity for older coins (profit mode).

**M2 insider (`m2-insider.ts`)** — *higher = worse (concentration risk).*
`score = 0.55·top3·youngness + 0.30·(bundle+sniper)/10 + 0.15·thinCrowd`. `youngness=0.5` if age<60s (small sample distrust). `thinCrowd=0.6` when `uniqueBuyers5m<5 && earlyUniqueBuyers≥3`.

**M3 rug (`m3-rug.ts`)** — *higher = worse.* Takes the **max** of weighted components (any one strong signal is enough):
`max(0.95·devSell, 0.85·concentration, 0.85·drawdown, 0.70·sellPressure, 0.80·babyDump, 0.70·rushLaunch, 0.60·erraticRsi, 0.55·thinFirst5m)`.
- devSell: 0.6 base if dev sold, scaled by `devSellVol/totalBuyVol`.
- concentration: top-3 buyer share tiers (0.85→1.0, 0.7→0.8, 0.55→0.5, 0.4→0.25).
- drawdown: peak→current vSol drop tiers (0.6→1.0, 0.4→0.7, 0.25→0.4, 0.1→0.15).
- babyDump: age<300s and `sellVol5m > buyVol5m*0.8 && sellVol5m>1` → 0.8.
- Kalacheva et al. 2026 features: rushLaunch (creation→first-trade <2s → 0.7, <5s → 0.45), erraticRsi (extreme+volatile 5m RSI → 0.55), thinFirst5m (<0.5 SOL turnover → 0.5).

**M4 creator (`m4-creator.ts`)** — *higher = worse.* No history → 0.5 (cautious). Else `0.6·rugRate + 0.2·spam + 0.2·dumpPenalty − 0.4·gradRate`; `<3 launches` is damped toward `0.3 + 0.7·raw`. dumpPenalty=0.6 if median time-to-dump <300s.

**M5 wash (`m5-wash.ts`)** — *higher = worse (fake volume).* `0.5·bump + 0.3·symmetryPenalty + 0.2·repetition`. bump=`bumpWallets/5`; symmetry=closeness of buy/sell counts AND volumes to 1:1 (needs ≥10 trades); repetition=trades-per-unique-buyer above 4 (needs ≥12 trades).

---

## 12. The three-gate copy-trade judge — `lib/intel/three-gate.ts`

A deterministic reproduction of Luo et al. WWW'26 §5.1.3 — three pass/fail gates each returning `{pass, confidence, reasons}`.

**`walletGate(buyers)`** — "will these recent buyers' next trade be profitable?"
- drop bump bots; require buyers with `tradeCount>5` (else lean negative, conf 0.35).
- significant = `t_stat > 1.645`; profitable = `avg_return > 0`; riskOk = `0 < std < 1.0`.
- `conf = 0.4·sigShare + 0.4·profShare + 0.2·riskShare − 0.15·bundleHeavyShare − 0.1·sniperHeavyShare`.
- **pass** = `≥2 significant buyers` OR `(≥1 significant AND ≥67% profitable)`.

**`coinGate(c)`** — "is the coin a good investment?"
- hard-reject: `flags.hasBundle` (conf 0) or `flags.mechanicalUptrend` (conf 0.05).
- sniper → confidence penalty `min(0.4, 0.1+0.05·count)`; bump → neutral.
- `moduleStrength = clamp01(gradScore − rugScore)`; `conf = 0.55·moduleStrength + 0.25·(flowOk?1:0.3) − snipPenalty`.
- **pass** = `!bundle && !mechanical && gradScore ≥ minGrad(0.55) && rugScore ≤ maxRug(0.35)`.

**`timingGate(t)`** — "is now a good entry?"
- `ageOk` = age in `[ageP25(60), ageP75(600)]`; `liquidityOk` = `vSol ≥ vSolP25(12)`; `sizeOk` = price impact `size/vSol < 0.05`.
- `conf = (ageOk?0.5:0.15) + (liquidityOk?0.3:0) + (sizeOk?0.2:0)`. **pass** = all three.

**`aggregateGates`** — `conf = 0.4·wallet + 0.4·coin + 0.2·timing` (weights learner-tunable via `readActiveGateWeights`); **pass = coin.pass AND wallet.pass AND timing.pass** (all three required).

---

## 13. The commit authority — `lib/intelligence/commit.ts`

This is the **sole writer** of `decision_log`, traces, and the auto-trade pending flag. Nothing else may create a tradable decision.

`planIntelligenceCommit(output, fusion, opts)`:
1. **Cooldown:** skip if same mint + same signal within `COOLDOWN_MS = 45000`.
2. Skip if signal not actionable or `NONE` (still fires JSONL trace + updates prior snapshot).
3. Map signal → legacy action (`BUY_STRONG`/`BUY_MODERATE`/`AVOID`…).
4. **Material change:** `hasMaterialChange` (eval-scheduler) — skip writes when nothing moved.
5. **Persist policy:** `shouldPersistDecisionLog(signal)` — only meaningful signals hit the DB.
6. `queueForAuto = buyAction && (output.auto_trade_allowed || AUTO_DEMO_RELAX)`.
7. Build `moduleScores` incl. sentinel keys: `_intelligence`=confidence, `_auto_trade_allowed`, `_strict_allowed` (strict gate result independent of demo-relax — lets the auto-trader run a strict-first pass and tag `entry_tier`), `_engine_a`, and `_v_sol` (derived from liquidity when missing).
8. `executed` = `pending` when queued, else `skipped`/`pending`. `threshold` stamped at **0.38**.

`prioritizePlannedCommits(planned, max=12)`: sort by `commitPriority(signal)` then `rank_percentile`, keep top-N, defer the rest. `flushIntelligenceCommits`: batched `insertDecisions` + `insertDecisionTrace` + JSONL + `emit intel:committed` + update prior-snapshot & mint-state registry.

---

## 14. The auto-trader — `lib/workers/auto-trader.ts`

The trading loop. `TICK_MS = 3000`. Reentrancy-guarded (`if (running) return`). **On boot it retires any session left `active`** — auto-trade stays OFF until the user explicitly presses Start (critical safety for live).

Each tick:
1. `getActiveSession()` — bail if none.
2. **Circuit breaker:** if HALTED → stop session.
3. **Daily loss cap:** `todayLossSol(session) >= maxDailyLossSol` → stop session. (Paper loss summed from `paper_positions` tagged `entry_features.session_id`; live from `live_trades`.)
4. Live availability check (`LIVE_EXECUTION=on` && wallet unlocked).
5. **`handleExits(session)`** (always runs, paper + live).
6. **Kill-switch** (`risk/kill-switch`): on a consecutive-loss streak (`recentConsecutiveLosses`, max 5 paper / `LIVE_MAX_CONSECUTIVE_LOSSES` live) → **pause new entries** for `ENTRY_COOLDOWN_MS = 5min` (exits keep running; auto-expires — distinct from the terminal daily-loss stop).
7. **`handleEntries(session)`** (unless paused).
8. `updateStats` for the mission-control UI.

### Entries (`handleEntries`)
- **Capacity:** `remaining = maxConcurrent − openCount`. The paper ledger + concurrency cap are **global** (single ledger id=1), so exits manage *every* OPEN position, not just this session's — otherwise positions orphaned by a stopped session hold the cap forever.
- **Queue:** `resolvePendingBuyQueue` reads pending BUY `decision_log` rows (120, fallback 180, then `fetchTradableAutoFallback`), `balancePendingQueue` interleaves launch (Engine A / `M1<0.35`) vs continuation candidates, `strictFirst` orders strict-allowed before relaxed.
- Per candidate: skip if already held; `shouldAcceptAction` vs `signalStrictness` (`strong` → BUY_STRONG only); skip `rug_labels='rugged'`; resolve vSol (`vSolHintFromModules` → batch → `resolveEntryVSol`), skip if none after 120s.
- **Bundle/mechanical veto:** hard in live; in demo with `AUTO_DEMO_RELAX` it logs and bypasses (observe-only).
- **Regime sizing:** `regimeSizedSol(session.sizeSol, regime.riskMultiplier)`, capped by `LIVE_MAX_PER_TRADE_SOL` in live.
- **Order-flow "don't buy a dump" gate (DEX coins):** fetch `fetchDexMarketBatchCached([mint])`; skip if `buysM5+sellsM5 ≥ 6 && buySellRatio < 0.7 && priceChangeM5 ≤ 0` (conservative — needs net selling AND a non-positive 5m move).
- `analyzeMintInsiders` → `qualifyEntry(ctx, {demoRelaxed})` (§15). `entry_tier` = strict unless `demoRelaxed && !strictAllowed && relaxedTierEnabled()`.
- **Real-mcap entry ceiling** (launch/hybrid, when `MAX_ENTRY_MCAP_USD>0`): skip if pump `usdMarketCap` exceeds the ceiling (stops an already-graduated $M coin slipping in as a "launch").
- **Open (paper):** single execution seam `TradeIntent → buildExecutionPlan → microSimulate → executePaperBuy → paperOpen`. `entry_features` stamps: session_id, action, gate confidences, imitation penalty, smartMoneyCount, `entry_tier`, `entry_age_seconds`, full DexScreener 5m order-flow (`dexBuySellRatio/volAcceleration/priceChangeM5/buysM5/sellsM5/volM5` — captured so the learner can mine which precede winners), exec metrics, and a real/estimated **entry mcap** (pump `usdMarketCap` preferred; else `mcapUsdFromVSol(v)`).
- **Open (live):** profile/confirm gates → micro-sim **hard gate** (never spend into thin depth / slippage blowout / gas spike) → `executeLiveBuy` → stamp session_id → open a **shadow paper trade** in parallel (`shadow_of=<live_id>`) for live-vs-model parity.

### Exits (`handleExits`)
- Params from session: `takeProfitPct`, `stopLossPct`, `maxHoldMinutes`, optional TP1 ladder (`tp1Pct`/`tp1Fraction`), trailing (`trailingArmPct`/`trailingStopPct`).
- **Graduation-aware current price** (`resolveCurrentForExit`): on-curve → `events.v_sol_after`; once graduated the curve value freezes, so derive an **effective vSol** from live pump `usdMarketCap` via `effectiveVSolFromMcapUsd` (keeps PnL tracking the real post-graduation price instead of stalling at breakeven — was marking an $80K position at a frozen $16K = 5× error).
- **PnL model:** if a real entry mcap and live mcap exist → `pnlFromMcap` (accurate on/off curve), and the close books a vSol `= entry·√(mcapNow/mcapEntry)` so the curve close (value ∝ vSol²) matches. Else fall back to `paperPnlSol` (curve model). Entry mcap is backfilled on the first young-position exit tick when the open-path pump fetch missed it.
- **Peak tracking:** `peak_pct`/`peak_at_ms` stamped in `entry_features` — feeds the trailing stop and the learner's exit-timing.
- **TP1 partial** (if ladder on & `pctOfSize ≥ tp1Pct`): `paperPartialClose(fraction)` then continue.
- **Exit decision** (`decidePaperExit`, §17) with `stagnationMs = round(maxHoldMs*0.4)`.
- On close: `paperClose` → `recordOutcome` → **3-layer causal attribution** (`attributePnl`: splits edge/execution/market so the learner never blames strategy for slippage or a rug) → accumulate session stats → notify.
- **Stale/dead mint:** no live price past max-hold → force-close at last mark (or entry) so capital + the concurrency slot are freed (`timeout_stale`).

---

## 15. The entry filter — `lib/trade/entry-filter.ts`

The final veto layer between a committed decision and an actual open. `qualifyEntry(ctx, {demoRelaxed})`:

**A. `passesConfluence`** — confluence floors `CONFLUENCE_MIN = {BUY_STRONG: 0.56, BUY_MODERATE: 0.48}`.
- insider boost: −0.03 (strong) / −0.02 (entry).
- **launch-tier de-bias:** a fresh launch's confluence ≈ graduation progress (low by definition). If launch-tier (`_engine_a≥1` or age<180s) with organic flow and `relaxedTierEnabled()`, subtract `0.1·launchQualityScore(...)` so *velocity*, not graduation, decides.
- `hardFloor` = 0.30 (with launch boost) / 0.36 (demo) / 0.42; `effectiveMin = max(hardFloor, relaxedMin − boost − launchBoost)`.

**B. `passesModuleVetoes`** (hard rejects, in order):
- `M2_INSIDER ≥ 0.58` → reject.
- `M5_WASH ≥ 0.65` → reject.
- `M4_CREATOR ≥ 0.65` (BUY_STRONG only) → reject.
- **`M3_RUG ≥ 0.70` → hard veto** (cannot be bypassed, not even by a strong insider entry — a 0.95-rug token previously entered via the insider exemption and lost 72%).
- `M3_RUG ≥ rugCap` (0.38 normal / 0.55 demo) → reject **unless** `hasStrongInsiderEntry`.

**C. Three-gate** (§12) with relaxed handling: profit/hybrid mode OR launch-tier → `relaxed`. In relaxed mode, a missing wallet profile passes on organic flow (`buys>sells && uniqueBuyers≥3`, conf 0.62/0.55), graduation floor drops to 0.12 (launch) / 0.45 (profit), maxRug 0.38, timing `ageP75` widens to 14400s and `vSolP25` to 5. Gate pass = `relaxed ? (coin.pass && timing.pass && (wallet.pass||flowOk)) : agg.pass`.

**D. Expected-edge:** `expectedEdge = tp·gateConfidence − imitationPenalty + insiderEdge`; require `≥ minEdge` (0.015 relaxed / 0.03 strict). Returns gate confidences (stamped into `entry_features`).

`qualifyDemoAutoEntry` is the minimal demo path: confluence floor by age (0.38/0.32 young, 0.44/0.36 mature) + module vetoes + vSol presence.

---

## 16. Risk presets & position sizing — `lib/risk/presets.ts`

| Preset | size SOL | maxConcurrent | TP | SL | maxHold | fees | slippage |
|---|---|---|---|---|---|---|---|
| conservative | 0.03 | 3 | 0.50 | 0.20 | 20m | 1% | 1% |
| balanced | 0.03 | 3 | 0.45 | 0.15 | 25m | 1% | 1% |
| aggressive | 0.10 | 8 | 1.50 | 0.40 | 45m | 1% | 1.5% |
| profit_seek | 0.05 | 2 | 0.35 | 0.12 | 35m | 1% | 1% |
| launch_snipe | 0.04 | 3 | 0.60 | 0.18 | 12m | 1% | 1.5% |

`profit_seek` widens TP so a win clears the ~2% round-trip friction on the non-linear curve (small nominal moves net to zero after fees+slippage). `regimeSizedSol` (`position-sizing.ts`) scales size by the current regime's `riskMultiplier` (smaller in rug-heavy/thin regimes). `kill-switch.ts` evaluates daily-loss + consecutive-loss + cooldown scopes.

---

## 17. Exit decision logic — `lib/paper/exit-decision.ts`

Pure, fully unit-tested (`exit-decision.test.ts`). Priority: **stop-loss → (once armed) trailing stop → fixed TP for small winners → stagnation cut → max-hold.**

```
decidePaperExit(pctOfSize, peakPct, ageMs, p):
  trailingArmed = trailEnabled && peakPct >= trailArmPct
  if pctOfSize <= -slPct           → "sl"          // hard stop always wins
  if trailingArmed:
    if pctOfSize <= peakPct - trailStopPct → "trail" // let winners RUN, no fixed TP cap
  else:
    if pctOfSize >= tpPct           → "tp"          // small winner takes fixed profit
    if stagnationMs>0 && ageMs>=stagnationMs → "timeout" // never built momentum → free capital
  if ageMs >= maxHoldMs            → "timeout"
  else                             → null            // hold
```

**"Let winners run":** the fixed TP only applies to positions that never armed the trail. Once a position runs past `trailArmPct` it's a real mover — drop the fixed cap and ride the trailing stop (captures a runner near its peak instead of capping at `tpPct`).

---

## 18. The chart subsystem

**Client** (`components/chart/TradingChart.tsx`, lightweight-charts v5) ← `useChartStream` which combines: a REST page load, `/api/tokens/[mint]/chart-state`, the WS feed (:8788), a **6s polling fallback** (skips when `document.hidden`), and a **1.5s on-chain live-price poll** (`/api/tokens/[mint]/live-price`).

**Server** (`lib/chart/runtime/chartRuntime.ts`) builds candles in two stitched segments:
- **Pre-graduation:** bonding-curve candles from `events` via `candleBuilder` (each candle **opens at the previous close** — DexScreener convention — so single-trade buckets show bodies, not doji dashes). Any timeframe (curve has dense trade data). `mcap = (vSol²/CURVE_DIV) × SOL_USD`.
- **Post-graduation DEX:** GeckoTerminal OHLCV (1m+). The curve segment is **normalized to connect** to the Gecko opening price (`factor = dexOpen / curveLast`) and a **"Migration" marker/line** is drawn at the boundary (`dexCandles[0].time`).
- **Live price** comes from on-chain PumpSwap pool reserves (`onchainPrice.ts`, current slot ~0.5s) via Helius — NOT DexScreener's REST (itself cached 30–60s, which lagged the chart ~1min). Uses `await getSolUsd()` (the sync fallback once caused a 2.24× mcap bug).

**Crash guards** (`components/chart/CandleSeries.ts`): `sanitizeAscending()` dedupes/sorts before `setData`; a positive `canIncrement` guard only calls `series.update()` on a provably-monotonic tail edit (fixes "Cannot update oldest data" and "data must be asc ordered by time").

**Worker chart lanes:** `chart-aggregator`, `chart-gecko-refresh` (20s DEX broadcasts), `chart-dex-quote`, `chart-graduation`, `chart-reconcile`. PumpSwap pool struct offsets (after 8-byte discriminator): base_mint@43, quote_mint@75, base_vault@139, quote_vault@171.

> ⚠️ **Operational gotcha:** the worker can't hot-reload chart code. Its WS SYNC_SNAPSHOT will clobber corrected REST data. **Restart `pnpm worker` after any chart change.**

---

## 19. The learning loop

- **`learner` lane** → `lib/db/repos/loss-learning.ts`: `mineLossPatterns` / `mineWinningPatterns` do univariate threshold splits over closed-trade features (incl. the captured DEX order-flow: `dex_buy_sell_ratio` [0.5,0.7,0.9,1.0], `dex_vol_acceleration` [0.3,0.5,0.8,1.0], `dex_price_change_m5` [-5,0,5]). Produces `learned_rules` (avoid/seek) and calls `tuner.recordChange` (deduped by reason within 24h).
- **Tuner** (`lib/db/repos/tuner.ts`, `lib/tuner/limits.ts`): when `AUTO_TUNE=on`, applies clamped threshold / gate-weight / rug-cap / gate-floor overrides. `clampToFraction`/`clampToDeviation` keep learning bounded — it can tighten/loosen but never blow the gates open. Gate floors come from `resolveGateConfig(mode, overrides)`.
- **`shadow-learner`** runs background paper trades (`SHADOW_LEARN_SIZE_SOL`) on filtered strong signals to grow the dataset independent of the live session.
- **`pnl-attribution`** (`intelligence/pnl-attribution.ts`) splits realized PnL into edge / execution / market so the learner credits/blames the right thing.
- **`regime`** classifies the current market (rug-heavy / thin / normal) and adjusts gate config + position size each commit tick.

---

## 20. Live execution & the wallet vault

- **Vault** (`lib/wallet/crypto.ts`): the imported secret key is **AES-256-GCM** encrypted with a key derived via **scrypt (N=32768)** from a passphrase; stored as an `EncryptedBlob` in `wallets_local`. The web process never holds a raw key.
- **Worker vault** (`lib/wallet/worker-vault.ts`): at boot, if `VAULT_PASSPHRASE` is set, the worker unlocks the vault so it can sign live trade intents. If unset, the worker stays **locked** and rejects all live intents at the executor.
- **Live path:** `LIVE_TRADE_INTENT_REQUESTED` (web) → `live-execution-listener` → `assertLiveExecutionAllowed` (profile + confirm + CB) → micro-sim hard gate → `executeLiveBuy/Sell` (`executor/live.ts`, via PumpPortal/Jupiter routes) → `live_trades`. `executor/live-phantom.ts` handles browser-Phantom-signed live trades (`PHANTOM_LIVE_RECORD`).
- **Guards:** `isLiveAllowed()` (profile=live + execution=on + confirm token), daily SOL + daily-loss caps, per-trade cap, consecutive-loss kill-switch, and the circuit breaker (HALT).

---

## 21. How the user interacts (UI + API surface)

**No login** — single operator on localhost. "User" = the operator plus an optional live wallet. Mode is **paper** (default), **live**, or **demo** (relaxed paper for observation), resolved by `lib/runtime/mode-authority.ts`. On worker boot the UI mode is cleared so the system starts "logged out" until the operator explicitly picks Demo/Real.

**Pages (14):** `/trade` (auto-trade + chart), `/mission` (mission control console), `/analytics`, `/learning`, `/market`, `/signals`, `/smart-money`, `/rings`, `/wallet`, `/token/[mint]`, `/paper`, `/backtest`, `/runtime`, `/notifications`. Data via polling (`useVisibleInterval`, `client-get` dedupe) + **SSE** (`/api/signals/stream`).

**Read APIs (~95):** `tokens/[mint]/{candles,chart-state,live-price,snapshot,transactions,user-trades,analysis,bundle}`, `intelligence/{console,feed,mint,token-bundle}`, `auto/{status,positions,log,session-insights,diagnostics}`, `analytics/*`, `continuation/*`, `learning/*`, `runtime/{health,postgres}`, `performance`, `signals`+`signals/stream`, `market/*`, `pump/*`, `wallet/status`, `holdings`.

**Gated write APIs** (→ `executeWebMutation` → `domain_events`): `auto/{start,stop,quick-start}`, `paper/reset`, `settings/{mode,signal-mode,limits}`, `state/{halt,resume}`, `trade/{prepare-buy,prepare-sell,quick-buy,quick-sell,sell-all,confirm-live}`, `wallet/{create,import,unlock,lock,wipe}`, `learning/rules`.

---

## 22. Worker lanes — full enumeration & cadence

Booted by `apps/worker/src/main.ts` → `startWorkers()` (orchestrator) + standalone listeners. The orchestrator also refreshes SOL/USD (60s) and the SIGNAL_MODE override (8s), clears the UI mode on boot, and logs the `domain_events` replay tail.

**Orchestrator lanes:** `ingestor` (WS, flush 500ms/100), `analytics`, `trader` (legacy, off unless `LEGACY_TRADER=on`), `auto-trader` (3s), `bot-detector`, `clusterer`, `rug-labeler`, `shadow-learner`, `trend-scanner`, `continuation-universe` (30s), `continuation-event-stream`, `intelligence-commit` (3s), `missed-winner-scan`, `retention`, `continuation-learner`, `learner`, `notifier`.

**Standalone (main.ts):** paper engine boot + reconcile, `paper-mark-to-market` (10s), `paper-reset-listener`, `live-execution-listener`, `paper-trade-listener`, `demo-reset-listener`, `web-command-listener`, `phantom-live-listener`, `runtime-snapshot-writer`, **chart WS server (:8788)** + `chart-aggregator` + `chart-dex-quote` + `chart-gecko-refresh` (20s) + `chart-reconcile` + `chart-graduation`.

All lanes call `touchWorker(name)` → `rpc_health`/heartbeat so `/api/runtime/health` can show liveness. Boot also retires any active auto-session.

---

## 23. Security model

- **Localhost only** (`127.0.0.1`). `.env.local` gitignored (real secrets); `.env.example` tracked (placeholders). **Never commit secrets or push API keys.**
- Web-write allowlist + worker-as-sole-writer; AES-256-GCM wallet vault (scrypt N=32768).
- Live execution gated behind explicit env (`profile=live` + `execution=on` + `confirm` token + unlocked vault) and `env()` throws on misconfig.
- Circuit breaker + daily loss cap + kill-switch.
- The automation never moves money beyond the configured auto-trader within its caps — manual live actions require the operator.

---

## 24. How to run / operate / test

```bash
# 1. Postgres (Docker)
docker compose up -d            # Postgres 16 on 127.0.0.1:5432

# 2. Web (UI + read API + gated writes) — NO workers
pnpm dev                        # http://localhost:3000

# 3. Worker (the automation runtime) — separate terminal
pnpm worker                     # boots DB migrate, vault, orchestrator, chart WS

# Reports / tools
pnpm session:report             # paper/live PnL summary
pnpm test                       # node:test across *.test.ts
pnpm worker:unlock              # unlock vault interactively (if not using VAULT_PASSPHRASE)
```

- **After ANY worker-side code change (trading, chart, intelligence): restart `pnpm worker`.** It does not hot-reload, and its in-memory state (chart snapshots, prior-snapshot maps) will otherwise clobber corrected data.
- To enable auto-trading: open `/trade` or `/mission`, pick mode, press **Start** (boot deliberately leaves it OFF).
- To go live: set `RUNTIME_PROFILE=live`, `LIVE_EXECUTION=on`, `LIVE_DRY_RUN=off`, `LIVE_CONFIRM=I_UNDERSTAND_REAL_MONEY`, and either `VAULT_PASSPHRASE` or `pnpm worker:unlock`. Verify caps first.

---

## 25. Runbook — known failure modes & fixes

| Symptom | Root cause | Fix |
|---|---|---|
| Chart fixes "don't stick" / look stale | Running worker has stale code; WS SYNC_SNAPSHOT clobbers corrected REST data | **Restart `pnpm worker`** |
| 404 on `/token/[mint]` routes | `.next` build cache corruption | Stop dev server, delete `.next`, restart `pnpm dev` |
| "Cannot update oldest data" (chart) | incremental `series.update()` got a time older than last bar | already fixed via `canIncrement` positive guard in `CandleSeries.ts` |
| "data must be asc ordered by time" | duplicate timestamp | already fixed via `sanitizeAscending` |
| mcap ~2.24× too high | used `getSolUsdSync()` ($150 fallback) instead of real ~$67 | use `await getSolUsd()` (already in `onchainPrice.ts`) |
| Chart ~1min behind DexScreener | DexScreener REST is itself cached 30–60s | read on-chain pool reserves (already in `onchainPrice.ts`) |
| Auto-trader opens nothing | no active session (retired on boot), or all candidates vetoed | press Start; check `/api/auto/diagnostics` skip reasons |
| Position stuck OPEN forever | dead/illiquid mint, no live price | force-closed at max-hold via `timeout_stale` path |
| GeckoTerminal empty candles | rate-limit (30/min) on bursts | cached + backoff in `geckoOhlcv`; wait it out |
| `env()` throws at boot | live flags set without `LIVE_CONFIRM` token | set `LIVE_CONFIRM=I_UNDERSTAND_REAL_MONEY` or turn live off |
| Worker exits immediately | another worker holds the singleton lock | stop the other `pnpm worker` (or clear the lock row) |
| Live intents all rejected | vault locked | set `VAULT_PASSPHRASE` or run `pnpm worker:unlock` |

---

## 26. Database reference (every table & column)

Two table families coexist:
- **Drizzle ORM tables** — defined in `lib/db/schema/*.ts`, migrated by `drizzle-kit`.
- **Raw-SQL tables** — the paper engine + `domain_events`, defined directly in `drizzle/*.sql` (the paper engine is the FSM ledger and predates being ported to Drizzle).

`getDb()` (Drizzle) and `getPool()` (raw `pg`) both target the same database. The worker runs all migrations at boot (`lib/db/migrate.ts`).

### 26.1 Ingest & market truth

**`events`** — every on-chain pump.fun event. *The primary on-chain truth.*
`id, signature, instruction_index, slot, ts, kind(buy|sell|create|complete|snapshot), mint, wallet, side, sol_amount, token_amount, v_sol_after, program, raw(jsonb)`. Unique `(signature, instruction_index)`; indexed on `(mint,ts)`, `(wallet,ts)`, `slot`, `kind`.

**`parse_errors`** — `id, signature, slot, ts, reason, details(jsonb)`.

**`tokens`** — `mint(PK), created_at, first_seen_slot, creator, decimals, supply, name, symbol, status, graduated_at, last_safety_verdict(jsonb), last_safety_at, blocked_for_trading, metadata_uri`.

**`mint_registry`** — `mint(PK), symbol, name, first_seen_at, engine_origin, lifecycle_state, migration_at, primary_pool, primary_dex, pool_count, updated_at`.

**`pool_registry`** — `mint, pair_address, dex_id, liq_usd, price_usd, updated_at`.

**`trend_candidates`** — DEX-trend discovery rows (DexScreener-sourced active mints).

### 26.2 Features

**`token_features`** — per-mint snapshot (the M-module inputs + scores): `mint, ts, v_sol, curve_progress, curve_velocity_5m, trades_per_sol, buy_vol_5m, sell_vol_5m, buys_5m, sells_5m, ofi_1m/5m/15m, holder_top1_pct, holder_top10_pct, unique_buyers_5m, holder_growth_5m, bot_ratio, insider_net_sol_5m, successful_trader_count, momentum_score, grad_score, rug_score, creator_score, holder_health, wash_score, cluster_quality, confluence_score, meta_prob_good_trade, calibrated_grad_prob, extras(jsonb)`.

**`wallet_features`** — `wallet(PK), first_seen, last_seen, trade_count, realized_pnl_sol, win_rate_30d, avg_entry_slot_offset, is_bot_score, is_sniper_score, insider_score, cluster_id, labels(jsonb)`.

**`creator_features`** — `creator(PK), launches, graduations, rugs, median_time_to_dump_sec, spam_score, creator_score, last_updated`.

**`dex_features`** — DexScreener 5m aggregates (the order-flow signal for graduated coins): `mint(PK), vol_m5/h1/h24, vol_acceleration, liq_usd, liq_growth_proxy, buys_m5, sells_m5, buy_sell_ratio, pool_count, trend_rank, price_change_m5/h1/h24, pair_created_at, migration_age_hours, continuation_score, exhaustion_risk, updated_at`.

### 26.3 Bots & clustering

**`mint_bot_flags`** (Luo et al. detectors) — `mint(PK), creator, launch_slot, launch_ts, has_bundle, has_sniper, has_bump_bot, mechanical_uptrend, bundle_wallet_count, sniper_wallet_count, bump_wallet_count, early_unique_buyers, detected_at, raw`.

**`wallet_profiles`** (the wallet-gate stats) — `wallet(PK), distinct_mints, closed_mints, trade_count, avg_return, std_return, t_stat, last_return, last5_return, last10_return, first_seen, last_seen, is_bump_bot, bump_score, sniper_rate, bundle_rate, recent_returns(jsonb), last_updated`.

**`wallet_edges`** — SOL-transfer graph for cluster detection: `id, from_wallet, to_wallet, lamports, slot, signature, ts, edge_type`.

**`clusters` / `cluster_members`** — sniper/bundle ring groupings (union-find output). **`rug_labels`** — per-mint rug verdicts (`rugged`/…) consumed by the auto-trader skip path.

### 26.4 Intelligence / decisions

**`decision_log`** — *the pending-buy queue the auto-trader consumes.* `id, ts, mint, action(BUY_STRONG|BUY_MODERATE|AVOID|…), confluence_score, threshold, modules_fired(jsonb), module_scores(jsonb), vetoes(jsonb), reason_human, mode, executed(pending|skipped|…), executor_reason`. Indexed `(mint,ts)`, `action`.

**`decision_trace`** — full per-evaluation trace: `id, ts, mint, stage, engine, action, reason(2048), vetoes, confidence, feature_snapshot(jsonb)`.

**`continuation_candidates`** — Engine B universe row: `mint(PK), continuation_score, trend_rank, source, dex_h24_pct, liq_usd, alert_action, momentum_state, rank_percentile, vol_rank_percentile, liq_rank_percentile, rank_velocity, state_confidence, p_breakout, p_exhaustion, p_continuation, engine_b_action, engine_b_json(jsonb), updated_at`.

**`continuation_events`** — `id, mint, ts, kind, payload`. **`engine_b_traces`** — `id, mint, ts, trace(jsonb), action, score, engine_b_version`. **`normalized_snapshots`** — `id, mint, ts, snapshot(jsonb)`.

### 26.5 Trading — the paper engine (raw SQL, migrations `0014`/`0015`)

**`paper_sessions`** — one row per portfolio epoch (a reset starts a new one): `id, started_at, ended_at, starting_balance_sol, ending_balance_sol, reset_reason`.

**`paper_portfolio`** — **exactly one row, `id=1` (CHECK-enforced singleton)**: `session_id, balance_sol, equity_sol, realized_pnl_sol, unrealized_pnl_sol, peak_equity_sol, total_trades, wins, losses, created_at, updated_at`.

**`paper_positions`** — **THE single paper ledger.** FSM `state ∈ {INTENT, OPEN, CLOSING, CLOSED}`. Columns: `id, session_id, correlation_id, mint, symbol, side, state, entry_price(=entry vSol), exit_price, quantity, notional_sol, current_price, realized_pnl_sol, unrealized_pnl_sol, stop_loss, take_profit, opened_at, closed_at, close_reason` + (0015) `entry_features(jsonb), modules_at_entry(jsonb), tp1_fraction, tp1_realized_sol, tp1_at_price, tp1_at_ts, decision_id`. The **`entry_features` JSONB** is the workhorse — it carries `session_id`, `action`, gate confidences, `entry_tier`, `entry_age_seconds`, `peak_pct`/`peak_at_ms`, `entry_mcap_usd`/`entry_mcap_real`, the DexScreener order-flow at entry, exec-memory metrics, and PnL attribution.

**`paper_trade_fills`** — audit of every simulated buy/sell: `id, position_id(FK), fill_type, fill_price, quantity, notional_sol, slippage_bps, fee_sol, latency_ms, created_at`.

**`paper_trades_compat`** (VIEW) — *introduced in `0015`, **dropped in `0017_drop_paper_trades_compat.sql`** once readers were migrated.* It mapped `paper_positions` back to the legacy `paper_trades` column shape (`entry_v_sol`, `exit_v_sol`, `size_sol`, `pnl_sol`, `exit_reason`, …). Readers now use `PAPER_TRADES_READ` (the inline `sql.raw` view expression in `lib/db/repos/paper-trades.ts`) directly.

**`paper_trades`** (legacy Drizzle table) — historical, read-only going forward: `id, mint, side, status, size_sol, entry_price, exit_price, fees_sol, slippage_bps, pnl_sol, exit_reason, entry_features, modules_at_entry, opened_at, closed_at`.

**`live_trades`** — the live ledger: the same trade columns **plus** `network, buy_signature, sell_signature, tx_signature_open, tx_signature_close, dry_run, error_message, route, session_id`.

**`auto_sessions`** — one row per Auto-Trade session (only one `status='active'` at a time): `id, started_at, stopped_at, status, mode(paper|live), params(jsonb), stats(jsonb), stop_reason`.
- `params`: `sizeSol, takeProfitPct, stopLossPct, maxConcurrent, maxDailyLossSol, signalStrictness(strong|strong_and_moderate), useLearnedAvoids, maxHoldMinutes, tp1Pct, tp1Fraction, trailingArmPct, trailingStopPct`.
- `stats`: `tradesOpened, tradesClosed, wins, losses, realizedPnlSol, lastTickAt, lastPendingCount, lastOpenedCount, lastSkipReasons, recentFilterSkips`.

### 26.6 Outcomes & learning

**`trade_outcomes`** — forward price track after entry: `id, source, trade_id, price_t0/t_1m/t_5m/t_30m/t_1h/t_6h, max_gain_pct, max_drawdown_pct, graduated_within_24h, extras, recorded_at`.

**`signal_outcomes`** — same idea for *emitted signals* (not just trades): `id, mint, decision_id, ts, action_emitted, confluence_score, price_t0..t_1h, graduated_within_24h, extras`.

**`loss_postmortems`** — entry context for losing trades (mining input): `id, recorded_at, source, trade_id, mint, pnl_sol, pnl_pct, exit_reason, entry_action, features(jsonb), modules_at_entry`.

**`learned_rules`** — auto-derived avoid/seek filters: `id, created_at, feature_key, operator(lt|gt|…), threshold, sample_n, loss_rate, status(proposed|active|…), reason, metrics`.

**`tuner_changes`** — audit of every tuning change (deduped 24h): `id, ts, reason, diff(jsonb), metrics_before, metrics_after, reverted`.

### 26.7 Chart

**`chart_stream_state`** — `mint(PK), epoch, last_trade_id, last_seq, graduation_at, regime(bonding_curve|dex), updated_at`. **`mint_dex_quotes`** — `id, mint, ts, price_usd, mcap_usd, source` (unique `(mint,ts,source)`). **`chart_candle_checkpoints`** — `(mint,tf)(PK), epoch, last_trade_id, candles_json(jsonb), checksum, updated_at`.

### 26.8 Runtime / ops

**`domain_events`** — *the command bus + durable event log* (`+ session_id, correlation_id`). Wire types `*_REQUESTED` / `*_COMPLETED` / `*_RECORDED` / `*_REJECTED`. **`user_settings`** — `key(PK), value, updated_at` (UI mode, signal mode, trade-size overrides). **`wallets_local`** — `id, created_at, updated_at, label('main'), public_key(unique), encrypted_secret(AES-256-GCM), source`. **`rpc_health`** — `endpoint(PK), kind, last_checked_at, p50/p95_latency_ms, error_rate_5m, rate_limited_count, cooldown_until, is_healthy`. **`dead_letters`** — `id, ts, queue, job_name, attempts, error, payload`. Reserved: the table and its index exist, but nothing writes to or reads from it — failed work is not currently captured here. Plus **`notifications`**, **`cb_events`** (circuit breaker history).

---

## 27. Frontend reference (pages, components, client data flow)

Next.js App Router. Server-component pages render `'use client'` components. There is **no global SSR data fetch for live state** — the client pulls via polling + SSE + the chart WebSocket. Chart code is client-only.

### 27.1 Pages → top component

| Route | Page file | Renders |
|---|---|---|
| `/` | `app/page.tsx` | `LandingPage` — home + Demo/Real mode picker (`ModeGate`/`TradingModeProvider`) |
| `/trade` | `app/trade/page.tsx` | `TradePage` (`TradePageProvider`) — `AutoTradeHero`, chart, `AutoTradePositions`, `AutoTradeLog` |
| `/mission` | `app/mission/page.tsx` | `MissionControlShell` — `MissionTerminal`, `EngineHeatmap`, `MomentumArena`, `RankVelocityChart`, `WhyMissedPanel`, `AutoTradeSafetyPanel` |
| `/token/[mint]` | `app/token/[mint]/page.tsx` | `TokenPageClient` — `TradingChart`, `TokenIntelligencePanel`, `TokenTxFeed`, `TokenQuickTrade` |
| `/analytics` | `app/analytics/page.tsx` | `AnalyticsPage` |
| `/learning` | `app/learning/page.tsx` | `LearningPanel` + `LearnedRulesPanel` |
| `/market` | `app/market/page.tsx` | `MarketView` / `TrenchesMarket` / `TrenchCoinCard` |
| `/signals` | `app/signals/page.tsx` | `SignalDashboard`, `TokenSignalList`, `TerminalHotSignals` |
| `/smart-money` | `app/smart-money/page.tsx` | `SmartMoneyPanel` |
| `/rings` | `app/rings/page.tsx` | `ClustersPanel` |
| `/wallet` | `app/wallet/page.tsx` | `WalletPage` — `WalletPanel`, `WalletSetupModal`, `WalletAnalyzer` |
| `/paper` | `app/paper/page.tsx` | paper positions + `paper/ResetModal` |
| `/backtest` | `app/backtest/page.tsx` | `BacktestPage` |
| `/runtime`, `/diagnostics/runtime` | `app/runtime/page.tsx`, `app/diagnostics/runtime/page.tsx` | `RuntimeHealthDashboard` (`runtime/ModeBanner`) |
| `/notifications` | `app/notifications/page.tsx` | `NotificationsPage` |

### 27.2 Component groups (`components/`)

- **Chart (`chart/`):** `TradingChart` (the lightweight-charts v5 host), `useChartStream` (combines REST + chart-state + WS + polling + live-price), `CandleSeries` (sanitize/append guards), `bsMarkers` (buy/sell markers), `graduationLine` (migration marker), `ChartToolbar` (timeframes), `ChartOhlcvLegend`, `ChartSideHud`, `chartStore` (zustand), `chartTheme`, `format`, `PriceChart`/`TokenChart` (wrappers).
- **Layout (`layout/`):** `AppChrome`, `TopNav`, `PortalLayout`, `AdvancedPageShell`.
- **Mission (`mission/`):** `MissionControlShell`, `MissionTerminal`, `EngineHeatmap`, `MomentumArena`, `RankVelocityChart`, `EventHeartbeat`, `WhyMissedPanel`, `AutoTradeSafetyPanel`, `TokenIntelligenceDrawer`.
- **Trade:** `TradePage`, `AutoTradeHero`, `AutoTradePositions`, `AutoTradeLog`, `AutoTradeInsights`, `TradeLimitsEditor`, `TradeSizePicker`, `TradeModeBanner`, `TokenQuickTrade`, `BreakevenHint`, `trade/TradePageProvider`.
- **Mode / wallet:** `ModeGate`, `RealModeGate`, `ModeGlossary`, `TradingModeProvider`, `WalletPanel`, `WalletSetupModal`, `WalletAnalyzer`, `SessionWalletBalance`, `phantom/PhantomConnectRoot`, `phantom/PhantomWalletChip`, `runtime/ModeBanner`.
- **Intelligence / signals:** `IntelligenceCommitFeed`, `IntelligenceTruthViewer`, `TokenIntelligencePanel`, `SignalDashboard`, `TokenSignalList`, `TerminalHotSignals`, `RadarScoresStrip`, `ContinuationPanel`, `SmartMoneyPanel`, `ClustersPanel`, `RugInsightsPanel`, `ShadowParityPanel`, `LearningPanel`, `LearnedRulesPanel`, `PerformancePanel`.
- **Misc:** `NotificationsBell`, `NotificationsPage`, `HaltButton` (circuit breaker), `WorkersStatusBanner`, `RuntimePerfBeacon`, `ChunkLoadRecovery` (reload on stale chunk), `CopyButton`, `DemoGuideOverlay`, `PumpCoinSearch`, `TokenDexView`, `TokenTxFeed`, `terminal/MintLivePrice`, `runtime/RuntimeHealthDashboard`.

### 27.3 Client data-flow primitives (`lib/ui/`)

- `useVisibleInterval` — poll only while the tab is visible (saves RPC/DB when hidden).
- `client-get` / `fetch-dedupe` — dedupe concurrent GETs to the same endpoint.
- `useSignalsStream` — subscribes to the `/api/signals/stream` SSE feed.
- `useSolUsd` — shared SOL/USD for mcap display; `store` — zustand UI store.
- `auto-trade-prefs` / `trade-size-prefs` / `trade-log-prefs` — persisted UI prefs.
- `format`, `intelligence-labels`, `plain-labels`, `momentum-states` — display formatting (turns engine internals into human labels).
- `useDeferReady` / `useVisibleInterval` — render/poll gating.

The chart additionally opens a **WebSocket** to the worker (`NEXT_PUBLIC_CHART_WS_URL`, default `ws://127.0.0.1:8788/chart`) for push updates, with the 6s poll + 1.5s live-price poll as fallbacks.

---

## 28. Per-file index (every `lib/` file)

One line per non-test `.ts` file, grouped by directory. (Tests are colocated `*.test.ts`.)

**`lib/` root**
- `env.ts` — Zod-validated config + mode/RPC helpers (§4).
- `log.ts` — structured logger factory. `notify.ts` — Discord/Telegram + DB notifications. `trade-client.ts` — browser trade API client.

**`api/`** — `short-cache.ts` (in-memory TTL cache for read routes), `token-analysis.ts` / `token-bundle.ts` / `token-bundle-data.ts` (assemble per-token read payloads).

**`arch/`** — `event-bus.ts` (in-process pub/sub; `ingest:flush`, `intel:committed`).

**`auto/`** — `diagnostics.ts` (auto-trader skip-reason surface), `session-positions.ts`, `status-snapshot.ts` (mission-control status).

**`backtest/`** — `runner.ts` (replay historical events through the strategy), `learn.ts` (offline learning over backtests).

**`chart/`**
- `constants.ts`, `timeframes.ts`, `types.ts` — chart config/types.
- `data/candleBuilder.ts` — OHLC bucketing (opens at prev close). `dexCandles.ts` — DEX candle assembly. `geckoOhlcv.ts` — GeckoTerminal OHLCV fetch (cached). `onchainPrice.ts` — live mcap from PumpSwap reserves. `priceResolver.ts` — price source selection. `marketCap.ts` — vSol↔mcap. `graduation.ts` — graduation boundary detection. `dexPool.ts` / `dexQuoteRefresh.ts` — pool resolution + quote refresh. `chartActiveMints.ts` — which mints to stream. `chartCache.ts` — candle cache. `tradeStore.ts` — in-memory trade buffer. `userTrades.ts` — user's own markers. `ingestBridge.ts` — push ingest events into the chart.
- `engine/indicators.ts` (MA/RSI/volume), `markerEngine.ts` (marker layout), `positionBuilder.ts` (entry/exit overlays), `reconcile.ts` (snapshot reconcile).
- `realtime/commitPipeline.ts` (candle commit), `eventRouter.ts` (route ws events).
- `runtime/chartRuntime.ts` (server candle assembly + curve↔DEX stitch), `chartWsServer.ts` (the :8788 WS server).

**`circuit-breaker/`** — `state.ts` (HALT/resume read/write).

**`continuation/`** (Engine B internals)
- `engine-b.ts` (orchestrator), `score.ts` (thin wrapper), `momentum-state.ts` (state posterior), `probability.ts` (breakout/exhaustion), `fusion.ts` (component blend + gates), `leading-signals.ts` (early-momentum precursor score from liq slope, vol derivative, h1-vs-m5, buy/sell ratio), `archetype.ts` (classify into launch_early / migrated_breakout / dex_parabolic / exhaustion / thin_liq), `cross-mint-rank.ts` (percentile ranking), `stages.ts` (lifecycle stages).
- `state-registry.ts` (prior-state cache), `state-transition-alerts.ts` (transition overrides), `detection-timing.ts` (first-seen timing).
- `engine-b-trace.ts` / `trace-store.ts` / `engine-b-compare.ts` (traces), `engine-a-baseline.ts` (A baseline for compare).
- `emit.ts` (candidate emit), `interrupt-pipeline.ts` (observe Engine B state transitions only — records history, no decision_log emits; commit owns those), `miss-classifier.ts` / `missed-report.ts` (missed-winner analysis), `eval-set.ts` / `eval-mints-public.ts` / `eval-report.ts` / `replay-runner.ts` (eval harness), `types.ts`.

**`db/`**
- `client.ts` (bootDb/getDb), `migrate.ts` (run migrations), `write-queue.ts` (serialized batched writes), `retention.ts` (prune old rows), `paper-read.ts` (paper read view access), `query-metrics.ts`, `sql-timestamp.ts`.
- `schema/*` (20 Drizzle table defs — §26). `repos/*` (28 typed data-access modules: `events`, `tokens`, `features`, `bots`, `decisions`, `decision-trace`, `paper-trades`, `live-trades`, `auto-sessions`, `outcomes`, `loss-learning`, `tuner`, `rug-labels`, `clusters`, `continuation-candidates`, `dex-features`, `gate-stats`, `ingest-facts`, `intelligence-feed`, `live-creates`, `mint-registry`, `performance`, `settings`, `token-snapshot`, `trades-export`, `trading-mode`, `trend-candidates`, `analytics`).

**`dex/`** — `market-snapshot.ts` (DexScreener fetch + shape), `snapshot-cache.ts` (batched cache), `curve-mcap.ts` (vSol²↔mcap + inverse), `normalizer.ts` (DEX→normalized snapshot), `discovery.ts` (trend discovery), `embed.ts` (DexScreener embed helper).

**`executor/`** — `paper.ts` (paper PnL/fill), `live.ts` (live buy/sell via routes), `live-phantom.ts` (browser-Phantom live), `micro-sim.ts` (pre-trade slippage/gas sim), `exec-normalize.ts` (TradeIntent→ExecutionPlan→Outcome), `normalizer.ts` (`executePaperBuy`).

**`gmgn/`** — `rank.ts` (GMGN-style ranking helper).

**`hooks/`** — `usePoll.ts` (generic poll hook).

**`ingest/`** — `helius-pumpswap-stub.ts` (PumpSwap ingest stub/placeholder).

**`intel/`** — `three-gate.ts` (wallet/coin/timing gates), `insider-tracker.ts` (smart-money/insider analysis), `imitation.ts` (imitation/price-impact penalty), `union-find.ts` (wallet clustering DSU).

**`intelligence/`** (the brain — §7–13)
- `dual-engine.ts` (eval orchestration), `engine-router.ts` (A/B route), `engine-a-launch.ts` (Engine A), `engine-fusion.ts` + `engine-fusion-core.ts` (fusion), `engine-b-output.ts` (B output adapter), `normalized-adapter.ts` (eligibility), `scored-mint-adapter.ts` (module-score adapter).
- `commit.ts` + `commit-policy-core.ts` + `commit-input.ts` (decision authority), `decision-bridge.ts` (signal→action map).
- `auto-gate.ts` + `auto-gate-core.ts` (auto-trade gate), `gate-config.ts` (per-mode floors), `launch-hot.ts` + `launch-hot-gate.ts` (newborn fast-lane), `launch-rank.ts` (launch quality), `launch-velocity.ts` (velocity model).
- `regime.ts` (market regime), `eval-scheduler.ts` + `eval-scheduler-plan.ts` (which mints to score), `state-delta-detector.ts` (trigger/delta events), `event-triggers.ts` (detect volume-spike ≥2.5×, liquidity-jump ≥15%, rank-jump ≥0.2 pctl, new-pool/migration triggers), `bundle-cache.ts` (input bundle cache), `hot-mints.ts` (in-memory TTL hot-mint registry HOT/HOT_LAUNCH feeding the eval scheduler), `fast-lane.ts` (low-latency hot-path: in-memory eval of a fresh-launch event → enqueue → executor, target <100ms, audit writes async; env-gated `FAST_LANE=on`, default off).
- `pnl-attribution.ts` (edge/exec/market split), `transition-replay.ts` (step through historical snapshots to find the FIRST actionable signal, not the post-mortem end state), `build-console.ts` (mission console payload), `intelligence-jsonl.ts` (JSONL trace), `index.ts` / `types.ts` / `public-types.ts`.

**`market/`** — `discovery.ts` (active-mint discovery), `enrich-mints.ts` (metadata enrich), `flags.ts` (feature flags), `sol-usd.ts` (cached SOL/USD), `types.ts`.

**`mission/`** — `suggested-fix.ts` (mission-control fix hints), `types.ts`.

**`modules/`** — `m1-graduation.ts`, `m2-insider.ts`, `m3-rug.ts`, `m4-creator.ts`, `m5-wash.ts` (§11).

**`paper/`** — `engine.ts` (paperOpen/Close/PartialClose + bootPaperEngine), `exit-decision.ts` (pure exit logic), `math.ts` / `mcap-pnl.ts` / `curve-pnl.ts` (PnL models), `mtm-lane.ts` (mark-to-market lane), `price-resolver.ts` (graduation-aware live vSol), `sell-helpers.ts` / `sellable-positions.ts`, `read.ts` / `ui-positions.ts` / `ui-positions-stats.ts` (read models), `history.ts`, `reset-listener.ts`.

**`phantom/`** — `config.ts` (Phantom SDK config), `usePhantomLiveTrade.ts` (browser live-trade hook).

**`pump/`** — `parser.ts` (Borsh log decode), `program.ts` (program IDs/consts), `fun-api.ts` (`fetchPumpFunCoin`), `resolve-price.ts` (`resolveEntryVSol`), `fetch-json.ts` (HTTP helper), `trenches-cache.ts` (trenches list cache).

**`risk/`** — `presets.ts` (risk budgets), `position-sizing.ts` (regime-scaled size), `kill-switch.ts` (loss-streak/daily-loss kill switch).

**`rpc/`** — `ws-manager.ts` (Helius logsSubscribe + reconnect/backoff), `borsh.ts` (Borsh reader), `anchor.ts` (Anchor discriminators), `stats.ts` (ingest stats).

**`runtime/`** — `mode-authority.ts` (paper/live/demo resolution), `web-writes.ts` (executeWebMutation re-export for app), `worker-lock.ts` (singleton lock), `worker-heartbeat-db.ts` (heartbeat persistence), `runtime-snapshot.ts` (runtime snapshot writer), `live-guards.ts` (assertLiveExecutionAllowed), `queue-command.ts` (enqueue domain_events command), `auto-session-queue.ts`, `trade-session-id.ts`, `domain-events-read.ts`, `health-read.ts`, `postgres-read.ts`, `perf-tracker.ts`, `with-route-perf.ts` (route timing wrapper).

**`settings/`** — `signal-mode.ts` (UI signal-mode override load/refresh), `mode-lite-snapshot.ts` (assemble the lightweight mode/wallet/demo/session snapshot for the UI mode gate).

**`shared/`** — `types.ts` (cross-cutting types incl. `RiskPreset`).

**`signals/`** — `quality.ts` (score + tier hot/good/fair/weak/avoid + tradable flag for a signal), `missed-profit.ts` (missed-profit scan).

**`trade/`** — `entry-filter.ts` (final veto), `opportunities-lite.ts` (fast trade-page opportunities list — no rings/flow/smart-money joins), `tier-control.ts` (relaxed-tier enable/disable), `tradeable.ts` (tradeable check), `timing-age.ts` (age coalescing), `bootstrap-data.ts`.

**`tuner/`** — `limits.ts` (clamp helpers `clampToFraction`/`clampToDeviation`).

**`ui/`** — client hooks/utils (§27.3).

**`wallet/`** — `crypto.ts` (AES-256-GCM + scrypt), `worker-vault.ts` (worker unlock/sign), `session.ts` (in-memory keypair session), `holdings.ts` / `balance.ts` (on-chain reads), `storage.ts` (wallets_local access), `copy-trade-safety.ts` (pure heuristic verdict — safe/caution/avoid/unknown — on whether a wallet is safe to copy-trade).

**`workers/`** — all automation lanes (§22): `orchestrator`, `ingestor`, `analytics`, `auto-trader`, `intelligence-commit`, `continuation-universe`, `continuation-event-stream`, `continuation-learner`, `bot-detector`, `clusterer`, `rug-labeler`, `shadow-learner`, `trend-scanner`, `missed-winner-scan`, `retention`, `learner`, `notifier`, `decision`, `trader` (legacy), `heartbeat`, `live-execution-listener`, `paper-trade-listener`, `demo-reset-listener`, `web-command-listener`, `phantom-live-listener`, and the 5 chart lanes (`chart-aggregator-lane`, `chart-dex-quote-lane`, `chart-gecko-refresh-lane`, `chart-graduation-lane`, `chart-reconcile-lane`).

**`packages/`** — `@spr/db` (`connect`, `web-writes`, migrate), `@spr/core` (`appendEvent`/`replay`/trade-FSM/reconcile/metrics), `@spr/trading` (`executor`/`portfolio`/`pnl`/`pricing`/`risk`/`slippage`/`state-machine`).

---

*End of Part I (as-built handoff). If you change behavior, update the cited section so this file stays the single source of truth.*

---
---

# Part II — Fix & Upgrade Plan

A single, ordered plan that (1) hardens the system you have and (2) layers in real local AI — in the right order, sized to a Ryzen 7 / 24 GB / RTX 4060 8 GB laptop, with no paid APIs in the runtime path. File paths reference Part I of this doc.

---

## Operating principles (read first)

These four rules decide every call below. If a later instruction ever conflicts with one of these, the principle wins.

1. **Measurement before intelligence.** You cannot improve what you cannot measure out-of-sample. The current system's edge is *unproven*. Build the apparatus that proves or disproves it before building anything that assumes it.
2. **Defense before offense.** Cutting tail losses (`P(rug)`, exit timing, sizing) is a higher-base-rate, lower-variance, more tractable problem than picking 5x runners. Build the defensive model first; it's the most likely real win.
3. **AI advises, deterministic systems decide.** No model ever touches the circuit breaker, daily-loss cap, vault, live-confirm, max-position, or the hard rug veto. Those stay deterministic and hard. ML only ranks, scores, sizes, and explains.
4. **Stay in paper longer than feels necessary.** Judge on out-of-sample, risk-adjusted return across at least one full pump.fun meta shift — not on hit rate, not on whether the logs look clever.

> One honest note, stated once: retail automated sniping on pump.fun is structurally tilted against the operator (latency, capital, MEV, and insiders who are often the cause of the very winners you're trying to catch). ML changes the odds at the margin, not the structure. This plan is built to make the experiment cheap and the feedback brutally honest. I'm not a financial advisor; treat the live phase as the smallest, last, most reversible step.

---

## 1. Issues register (current system, pre-AI)

Everything wrong or fragile in the system as documented, with severity and where it gets fixed. Severity is about *risk to your money and to your ability to trust the system's numbers*, not code aesthetics.

| # | Issue | Severity | Root cause | Fix | Phase |
|---|-------|----------|-----------|-----|-------|
| 1 | No proof of edge; no out-of-sample paper evaluation | **Critical** | System judged by hit rate / vibes, never by OOS risk-adjusted return | Walk-forward paper eval harness (Sharpe, tail loss, by regime/archetype) | 1–2 |
| 2 | Feature-logging selection bias | **High** | Features only computed for universe mints (`INTELLIGENCE_UNIVERSE_MAX 150`, top-rank/changed/hot). Model would learn *given your gates* and go blind to filtered-out cases | Control sampler: randomly snapshot mints you'd normally skip, tagged `sample_source='control'` | 1 |
| 3 | Pricing / PnL path fragility | **High** | History of real bugs (2.24× mcap from `getSolUsdSync`, 5× frozen-vSol post-graduation). Patched, but path is intricate and untested at the invariant level | One price-resolution seam + property tests asserting PnL invariants on/off curve | 0 |
| 4 | Data-source SPOF & rate limits | **Medium-High** | DexScreener cache lag, GeckoTerminal 30 req/min, third-party CORS proxy. Silent staleness corrupts both trades and training labels | Source-health tracking, graceful degrade, never train on known-stale rows (flag them) | 0 |
| 5 | Rule spaghetti / regime fragility | **Medium** | Many hand-tuned thresholds (gate-config, entry-filter, confluence floors). Every meta shift wants a new exception | Don't rip out — shadow with a model, replace a threshold only once the model provably beats it | 3+ |
| 6 | "Learning" is univariate threshold mining | **Medium** | `mineLossPatterns`/`mineWinningPatterns` do single-feature splits — analytics, not prediction | Replace with calibrated multivariate models, keep the rule output as a *feature* | 3, 5 |
| 7 | Event retention vs. train-forever tension | **Medium** | `EVENT_RETENTION_DAYS 7` deletes the raw history you'd want for training | Partition `events` by day (cheap drop) + archive matured feature/label rows to Parquet | 0–1 |
| 8 | No probability calibration | **Medium** | Scores aren't probabilities; you can't size or threshold honestly | Isotonic/Platt calibration on every promoted model | 3 |
| 9 | No drift monitoring | **High (for ML)** | pump.fun meta turns over weekly; scammers mimic last week's winning pattern | Drift lane + short training windows + scheduled retrain; load-bearing, not garnish | 4–5 |
| 10 | Latency budget not formalized for added compute | **High** | Naive advice would put an LLM in the 3s commit / sub-100ms fast lane. It physically can't fit | Explicit latency tiers; tree inference inline via ONNX, LLM async only | 3 |
| 11 | Global paper ledger + shared concurrency cap | **Low-Medium** | Single `paper_portfolio` id=1 and global `maxConcurrent`; stopped-session positions can hold the cap | Clear per-session accounting or explicit ownership of OPEN positions | 0–1 |
| 12 | Worker can't hot-reload; `SYNC_SNAPSHOT` clobbers corrected data | **Low (operational)** | In-memory chart/prior-snapshot state | Restart discipline (documented) + a snapshot-version guard so stale state can't overwrite newer | ongoing |
| 13 | Disk pressure | **Low now, rising** | ~300 GB free; model caches, Parquet, pgvector index will eat it | Tiering (below) + free 150–200 GB before Phase 1 | 0 |

---

## 2. Target architecture + latency tiers

Keep your pipeline. Insert one advisory layer, and — the correction neither prior doc made — assign every new component to a **latency tier** so nothing breaks the timing budget you already engineered (the `FAST_LANE` instinct was right; make it explicit).

```
Market data / on-chain events
        ↓
Current engine + feature builders   ── writes feature_snapshots (+ control set)
        ↓
[INLINE TIER]  tree-model scores (ONNX, in-process) + precomputed kNN lookup
        ↓
Engine fusion / commit authority    ── unchanged decision seam
        ↓
Deterministic risk gates            ── HARD, never model-overridable
        ↓
Execution (paper → guarded live)
        ↓
[BACKGROUND TIER] kNN index refresh, archetype clustering, drift metrics
[ASYNC TIER]      LLM narration, label maturation, retrain, Parquet archive
```

| Tier | Cadence | Runs what | Hard rule |
|------|---------|-----------|-----------|
| **Inline** | 3s commit lane / <100ms fast lane | ONNX tree inference (µs–low-ms), precomputed kNN lookup, deterministic gates | Pure TypeScript in-process. **No** Python subprocess, **no** network, **no** LLM |
| **Background** | 20–30s (reuse `continuation-universe` cadence) | kNN index rebuild, archetype clustering, drift computation, calibration tracking | May touch DB; must not block the commit lane |
| **Async** | own lanes / scheduled | LLM narration, label maturation, retraining, Parquet archival | Out-of-band; writes are advisory/reporting only |

**The ONNX seam is the key trick:** train offline in Python (LightGBM/XGBoost), export the booster to ONNX, run it in-process via `onnxruntime-node`. The hot path stays pure TS with zero IPC latency, and Python never runs in production.

---

## 3. New data model

Add these alongside your existing schema (`lib/db/schema/*`, migrations in `drizzle/`). Kept deliberately separable so labels can mature asynchronously without touching the feature rows.

| Table | Purpose | Notes |
|-------|---------|-------|
| `feature_snapshots` | Point-in-time feature vector at each evaluation | Immutable. `mint, ts, features(jsonb), engine_outputs(jsonb), sample_source('universe'\|'control'\|'shadow'), stale_flags(jsonb)` |
| `outcome_labels` | Forward outcomes per snapshot | Filled by a label lane once horizons mature: `ret_5m/30m/1h/6h, max_drawdown, max_gain, is_rug, is_breakout, time_to_peak, time_to_graduation, label_ready_at` |
| `feature_vectors` | Normalized numeric vector for kNN | pgvector column over a **bounded recent window** only (drift makes old neighbors weak). No text embeddings |
| `archetypes` + `mint_archetype` | Cluster definitions + per-mint assignment | `archetype, confidence, nearest_ids, hist_win_dist` |
| `model_registry` | Versioned models | `name, version, onnx_path, train_window, features_hash, metrics(jsonb), status('shadow'\|'promoted'\|'retired')` |
| `model_predictions` | Logged inference for later scoring | `mint, ts, model_name, version, prediction, calibrated, acted_on` |
| `eval_runs` | Paper-performance evaluation output | `window_start/end, oos_sharpe, tail_loss_p95, win_rate, by_regime(jsonb), by_archetype(jsonb)` |
| `drift_metrics` | Feature/label drift over time | PSI/KL per feature, base-rate of positive labels per window |

You can drop the prior docs' `memory_chunks`/embedding tables entirely — your records are numeric, so kNN runs directly on `feature_vectors`. That deletes a whole moving part (the embedding model and its text-generation detour).

---

## 4. The phases

Each phase has a **goal**, the **build**, **files to touch**, a **done-when / kill-gate**, and **pitfalls**. Do not start a phase before its predecessor's gate passes. The gates are where the honesty lives — a "no" at a gate is a *successful* result, because it saves you months.

### Phase 0 — Triage & guardrails (week 0–1)

**Goal:** stop the bleeding and make the foundation trustworthy before you build on it.

**Build**
- Free 150–200 GB disk; verify Postgres/Docker volume headroom.
- Partition `events` by day so retention is a partition drop, not a delete scan. Decouple retention of raw events from the (small) feature/label rows you'll keep long-term.
- **Pricing seam + invariant tests.** Consolidate price resolution behind one function and write property tests asserting: PnL is continuous across the graduation boundary; `pnlFromMcap` and the curve model agree where both apply; SOL/USD is always the `await` path (never the sync fallback). This locks the 2.24× and 5× class of bugs out for good.
- Source-health tracking for DexScreener/Gecko/proxy: timestamp every external row, flag staleness, and **never** let a stale row silently become a trade entry or a training label.
- Per-session accounting clarity for the paper ledger (issue #11): make OPEN-position ownership explicit so a stopped session can't hold the concurrency cap.

**Files:** `drizzle/*` (partition migration), `lib/chart/data/onchainPrice.ts`, `lib/paper/price-resolver.ts`, `lib/paper/mcap-pnl.ts` + new `*.test.ts`, `lib/dex/snapshot-cache.ts`, `lib/market/sol-usd.ts`, `lib/db/retention.ts`, `lib/workers/auto-trader.ts` (session/cap ownership).

**Done when:** invariant tests green; events partitioned; no code path reads a stale or sync-fallback price.

**Pitfalls:** don't refactor the trading logic here — only the *measurement and pricing correctness*. Changing strategy and instrumentation at once makes results uninterpretable.

**Status (implemented):**
- ✅ **Pricing seam + invariant tests** — `lib/pricing/seam.ts` is now the single canonical home for the on-curve ↔ post-graduation PnL decision (`markPnl`), with `lib/pricing/seam.test.ts` locking the three invariants (ratio-based PnL is SOL-price-independent → the 2.24× class; round-trip identity; graduation continuity → the 5× class). `curve-mcap.ts` gained SOL-price-parameterized pure cores (`mcapUsdFromVSolAt` / `effectiveVSolFromMcapUsdAt`). The auto-trader exit path and `paper/price-resolver.ts` now route through the seam (behavior-identical).
- ✅ **Source-staleness flagging** — `solUsdFreshness()` (`lib/market/sol-usd.ts`, `SOL_USD_STALE_MS`) and `dexMarketCacheAgeMs()` (`lib/dex/snapshot-cache.ts`) expose source health; auto diagnostics now flag a stale/fallback SOL price.
- ✅ **Explicit OPEN-position ownership** — `fetchOpenOwnershipCounts()` (`lib/db/repos/paper-trades.ts`) + the partial expression index `drizzle/0019_paper_positions_session_owner_idx.sql` make auto-session ownership a first-class, indexed, queryable concept; auto diagnostics now surface `{total, ownedByActive, orphaned, untagged, globalCap}` and warn when orphaned positions from a stopped session are holding the global cap.
- ✅ **Global-cap-aware entry capacity** — the auto-trader's paper capacity now subtracts the *global* open count (orphans included) via the pure, unit-tested `entryHeadroom()` (`lib/trade/capacity.ts`), so a stopped session's positions can no longer make it attempt opens the kernel will reject; it also logs when orphans hold the cap.
- ✅ **Conservative paper fills (A2 — verdict integrity)** — the paper kernel (`packages/trading/src/paper/executor.ts`) now charges a **priority-fee drag** per on-chain leg (`config.priorityFeeSol`, default `LIVE_PRIORITY_FEE_SOL` 0.0005 SOL): a full close charges the round trip (entry+exit), each partial charges one leg. On a 0.03–0.05 SOL trade that's ~1–1.7%/side — material drag paper previously ignored, which biased PnL optimistically. Slippage was already liquidity-aware (`applySlippage` scales impact with `notional/referenceVSol`, capped 8%). All 13 kernel tests pass.
- ✅ **Stale-price entry skip (A3)** — the auto-trader skips ALL entries on a tick when `solUsdFreshness().usingFallback` (the SOL/USD feed hasn't warmed), so an entry-mcap stamp on a wrong SOL basis can't contaminate the mcap-PnL model. Exits + MTM keep running; the orchestrator warms the price every 60s.
- ⏳ **Deferred to Phase 0 ops:** the `events` day-partition migration (a destructive table rebuild — needs a live DB + downtime window, not a blind migration) and the disk free-up are operator/DB tasks.

---

### Phase 1 — Measurement backbone (the keystone)

**Goal:** turn every evaluation into a clean, point-in-time training example, *including the cases your gates currently hide*, and build the harness that judges paper performance honestly.

**Build**
- `feature_snapshots` written on every commit-lane evaluation (universe mints).
- **Control sampler lane** (fixes issue #2): each minute, randomly snapshot N mints the universe would skip, tagged `sample_source='control'`. You'll never trade most of them, but the model needs to see the filtered-out distribution or it just memorizes your gates.
- **Label lane** (async): once a snapshot's horizons mature, compute `outcome_labels` (forward returns, drawdown, rug/breakout flags, time-to-peak). Mark `label_ready_at`.
- **Paper-performance eval harness** (`scripts/eval-paper.ts` + `lib/intelligence/eval-harness`): walk-forward, time-based splits only, reports out-of-sample Sharpe, P95 tail loss, win rate, broken down by regime and (later) archetype. This is the number that decides everything.
- Parquet archival: on label maturity, export feature+label rows to `data/training/*.parquet`; train from Parquet, not the live DB.

**Files:** new `lib/db/schema/feature-snapshots.ts`, `outcome-labels.ts`; new lanes `lib/workers/feature-snapshotter.ts`, `lib/workers/control-sampler.ts`, `lib/workers/label-builder.ts`; `apps/worker/src/main.ts` (register lanes); `scripts/eval-paper.ts`; `lib/intelligence/eval-harness/*`.

**Done when:** snapshots accumulating for both universe and control; labels maturing automatically; `pnpm eval-paper` produces an OOS Sharpe + tail-loss report you trust.

**Pitfalls:** point-in-time correctness is everything — never let a label or a future value leak into a feature row. Random train/test splits will lie to you; use time splits.

**Status (implemented):**
- ✅ **Data model** — `drizzle/0020_measurement_backbone.sql` + `lib/db/schema/measurement.ts` create `feature_snapshots` (immutable point-in-time vector + engine output + `sample_source` + `stale_flags`) and `outcome_labels` (forward outcomes, one row per snapshot, matured async). Repo: `lib/db/repos/measurement.ts`.
- ✅ **Feature snapshotter** (`lib/workers/feature-snapshotter.ts`, 15s) — captures the point-in-time feature vector (token_features + dex flow + module scores) of every recently-evaluated **universe** mint, deduped within a short window, with source-health `stale_flags`.
- ✅ **Control sampler** (`lib/workers/control-sampler.ts`, 60s, issue #2) — randomly snapshots ~10 recently-active mints the universe did NOT evaluate, tagged `sample_source='control'`, so the dataset includes the filtered-out distribution.
- ✅ **Label builder** (`lib/workers/label-builder.ts`, 60s) — for matured snapshots, computes forward value-returns (bonding-curve `(vSol/ref)²−1`, the same basis the paper engine books), max gain/drawdown, rug/breakout flags, time-to-peak/graduation; reads only events strictly AFTER the snapshot ts (no leakage), excludes fallback-SOL-price rows.
- ✅ **Eval harness** — `scripts/eval-paper.ts` (`pnpm eval-paper`): out-of-sample, time-ordered walk-forward folds over closed `paper_positions` reporting per-trade Sharpe, P95 tail loss, win rate, total PnL, broken down by exit reason / entry tier / regime / **entry-age bucket (A5 — reaction latency: `<10s / 10-60s / 1-5m / 5-30m / >30m`, so you can see if late entries systematically lose)**, plus measurement-backbone counts. This is the Phase-2 gate number.
- All three lanes registered in `lib/workers/orchestrator.ts`; verified by `pnpm typecheck` (clean) and the test suite (no regressions). Lanes are additive — zero change to the decision/trading path.
- ✅ **Collection observability** — `lib/auto/diagnostics.ts` now surfaces `measurement {snapshotsUniverse, snapshotsControl, labelsComplete, labelsPending}` and warns if the worker is emitting BUYs but `feature_snapshots` is empty (lane crashed / migration 0020 not applied), so a silently-broken collection is caught during the run rather than weeks later.
- ✅ **Eval-run persistence (B2)** — `drizzle/0021_eval_runs.sql` + `evalRuns` schema; `pnpm eval-paper` now inserts a summary row each run and prints the recent OOS-Sharpe / tail-loss / PnL **trend**, so a meta shift is visible mid-run instead of after.
- ⏳ **Deferred (need a live DB/runtime to build correctly — not blind):**
  - **B1 — DEX-quote labeler for graduated coins.** The default `hybrid` mode trades graduated coins, which currently get null labels. Done right this is a *data-collection* build, not a query: graduated-coin forward price-in-SOL history isn't densely persisted anywhere, so the fix is (1) persist `sol_usd` per dex quote, (2) a universe price-ticker writing price-in-SOL for active graduated mints, (3) extend `label-builder` to compute SOL-denominated returns from it. Its labels only mature 6h+ after the ticker starts — so it must be built against a running system, not blind.
  - **B4 — batch the mark-to-market RPC reads** (one `getMultipleAccounts` for all open positions instead of per-position); efficiency under load, validate with the worker up.
  - **Parquet archival** (needs a parquet dep; `eval-paper`/training read the live tables until then).

---

### Phase 2 — Prove or kill (run, then decide)

**Goal:** answer the only question that matters before adding AI: *does the system you already have make money out-of-sample, across a meta shift?*

**Build:** nothing new. Run the existing deterministic system in paper for several weeks with Phase-1 logging on. Then read the harness.

**Kill-gate (be ruthless here):**
- If OOS risk-adjusted return is **not** positive across the window → **do not** proceed to ML-for-offense or to live. The strategy needs rethinking, not a model on top. This is a win: you've avoided building intelligence onto something that wasn't going to work.
- If it's positive → proceed. Your `feature_snapshots`/`outcome_labels` are now exactly the dataset you need.

**Pitfalls:** a good in-sample backtest is not edge. Short windows + rare positive labels = models and strategies that look great in-sample and evaporate live. Insist on out-of-sample.

---

### Phase 3 — Defensive ML: calibrated `P(rug)`

**Goal:** the highest-probability real improvement — trim your worst losses.

**Build**
- Train `P(rug)` (LightGBM/XGBoost, CPU) on the Phase-1 dataset, walk-forward, **calibrated** (isotonic/Platt) so the output is a real probability.
- Export to ONNX; load via `onnxruntime-node` in `lib/intelligence/model-scorer.ts`; score inline in the commit lane.
- Run it in **shadow** first: log `model_predictions`, don't act. Compare against the existing rug gate in paper.
- Promote only if it reduces P95 tail loss in paper *without* killing too many winners. Promotion = the model's score becomes a *feature* feeding the existing deterministic gate; the hard rug veto stays hard.

**Files:** `ml/train_rug.py` + `ml/export_onnx.py` (offline), `models/rug/<version>.onnx`, `lib/intelligence/model-scorer.ts`, `lib/db/schema/model-registry.ts`/`model-predictions.ts`, integrate into `lib/intelligence/commit.ts` feature bundle (not the veto path).

**Done / promote-gate:** shadow model beats the current rug gate on tail loss in paper, validated walk-forward, calibration curve sane.

**Pitfalls:** rug labels are imbalanced — use class weighting and judge on precision/recall at the operating threshold, not accuracy. Recompute calibration every retrain.

---

### Phase 4 — Memory & archetypes (numeric kNN)

**Goal:** "have we seen this before?" — without an embedding model.

**Build**
- Normalize feature vectors → `feature_vectors`; pgvector kNN over a bounded recent window (background tier; the commit lane only does a *precomputed* lookup).
- Cluster into archetypes (launch breakout, migrated breakout, thin-liq fakeout, insider-heavy, wash trap, slow grinder, exhausted runner). Store per-mint `archetype, confidence, nearest_ids, hist_win_dist`.
- Surface "similar historical cases + their outcomes" in the mission console.

**Files:** new `lib/intelligence/retrieval-scorer.ts`, `lib/continuation/archetype.ts` (extend the existing classifier — see reconciliation note), background lane `lib/workers/knn-index-lane.ts`, `lib/db/schema/feature-vectors.ts`/`archetypes.ts`; UI in `components/mission/*`.

**Done when:** decision-time lookup returns relevant neighbors with real outcome distributions; archetype assignment is stable week-to-week.

**Pitfalls:** old neighbors are weak under drift — keep the index windowed. Don't resurrect text embeddings for numeric data.

---

### Phase 5 — Offensive ML (sober) + drift

**Goal:** `P(breakout)`, expected return, model-driven position sizing — with eyes open about the ceiling.

**Build**
- Train `P(breakout)` / `expected_return` / `time_to_peak`, calibrated, walk-forward, ONNX-exported, shadow-first.
- **Drift monitoring is now load-bearing** (issue #9): `drift_metrics` lane tracking feature PSI/KL and positive-label base rate per window; trigger retrain on drift, not just on a schedule.
- Use model outputs to *size* (smaller in low-confidence/high-drift regimes), not to override gates.

**Files:** `ml/train_breakout.py` etc., `lib/risk/position-sizing.ts` (consume calibrated score), `lib/workers/drift-monitor.ts`, `lib/workers/retrainer.ts`.

**Sober expectation:** this part will underdeliver relative to the defensive model. Signal-to-noise on picking runners is terrible and adversarial. Promote only on OOS paper improvement, and don't let a clean backtest seduce you.

**Pitfalls:** overfitting to spurious "winner" patterns; non-stationarity. Short windows, frequent retrain, ruthless OOS validation.

---

### Phase 6 — LLM narration (async, optional)

**Goal:** human-readable "why" for decisions already made — *not* a decision-maker.

**Build:** small quantized model via Ollama on its own async lane. Input: the decision + scores + neighbors that were already computed. Output: a written explanation into the mission console after the fact.

**Files:** `lib/workers/narration-lane.ts`, UI in `components/IntelligenceTruthViewer` (you have it).

**Hard rule:** never inline, never in the fast lane, never touching a gate. It's a reporting layer. On 8 GB VRAM, keep it small and quantized; it's enough for narration, not for an all-purpose brain running alongside everything else.

---

### Phase 7 — Guarded live

**Goal:** smallest possible real-money step, last.

**Gate:** only after paper OOS Sharpe is stable across **at least one full meta shift**, with the defensive model promoted and drift monitoring live. Keep every existing hard guard (`LIVE_CONFIRM`, caps, kill-switch, circuit breaker, vault). Start at the floor of `LIVE_MAX_PER_TRADE_SOL`. Treat the first live weeks as continued measurement, not as "done."

---

## 5. Free stack ↔ your hardware

| Component | Tool | Runs on |
|-----------|------|---------|
| Storage / operational | Postgres 16 (you have it) | disk |
| Numeric similarity | pgvector (no embedding model) | CPU |
| Prediction training | LightGBM / XGBoost / CatBoost | Ryzen 7 (CPU) |
| Calibration | scikit-learn (isotonic/Platt) | CPU |
| **Inline inference** | **ONNX Runtime (`onnxruntime-node`)** | in-process TS, µs–ms |
| LLM narration (async, optional) | Ollama, small quantized model | RTX 4060 8 GB, one model at a time |
| Training data | Parquet on disk | disk |

All free. The genuinely non-free cost is the trading losses, priority fees, and failed-tx costs once live — which is the whole reason Phases 0–2 exist.

---

## 6. What not to do

- Don't put an LLM in the commit or fast lane. It can't meet the latency budget and adds no predictive edge on numeric decisions.
- Don't let any model override the circuit breaker, daily-loss cap, vault, live-confirm, max-position, or hard rug veto.
- Don't add more thresholds before you have labels and a model to justify them.
- Don't use text embeddings for numeric data.
- Don't train on universe-only data (selection bias) or on stale-flagged rows.
- Don't use random splits — time-based walk-forward only.
- Don't go live to "validate" — validate in paper; go live only after the gate.
- Don't treat the AI score (4/10 → higher) as the goal. A boringly well-calibrated rug-avoidance model beats any clever-sounding LLM supervisor.

---

## 7. Start here (this week)

1. Free disk; partition `events` by day.
2. Build the pricing seam + invariant tests (kills the 2.24×/5× bug class permanently).
3. Stand up `feature_snapshots` + the **control sampler** + the label lane.
4. Write `scripts/eval-paper.ts` and get one honest OOS Sharpe + tail-loss number out of it.

When that number exists and you trust it, you're past the hard part — everything after is incremental and gated. The first three items are pure correctness and instrumentation; none of them risks money, and all of them are prerequisites for trusting anything the system tells you later.

---

## 8. Kill-gate (pre-registered 2026-06-20)

> Locked in **before any data is seen** per the v2 plan's T0.2 — the entire point of pre-registration is to bind decisions that we cannot game after results land. If reading this later and you feel a number "should be relaxed," that is exactly the failure mode this section exists to prevent. Re-read first. Adjust only with a written justification dated and signed.

### The single metric (used identically in this kill-gate AND the T4 ablation report)

**Per-trade Sortino**, target τ = 0 (breakeven net of honest fees + T0.3 slippage):

```
Sortino = mean(r_i) / sqrt( mean( min(r_i − τ, 0)^2 ) )
```

where `r_i` is the realized return of closed trade `i`, net of T0.3 fees + slippage, and the denominator (downside deviation) averages squared shortfalls over **all** trades (zeros for trades at or above τ — not only losers; only-losers inflates the ratio).

**Per-trade, not annualized:** a high-frequency strategy's annualized Sharpe/Sortino swings wildly with the annualization factor and assumes iid daily returns that lumpy memecoin trading violates. Per-trade is robust to variants trading at different frequencies and cannot be gamed by convention choice. **Sortino, not Sharpe:** rug/moon outcomes are bimodally asymmetric; Sharpe penalizes the right-tail upside that is the entire point of the strategy.

### Pass bar — ALL 5 must hold for the best variant

1. **Per-trade Sortino ≥ 0.7.** (Plan-recommended skeptical-realistic midpoint. Calibration: ≥ 1.0 means mean trade return ≥ downside deviation, which is a strong bar for this asset class; ≥ 0.5 is the generous floor. 0.7 balances "don't kill a real edge in a noisy asset class" against "don't pass on a marginal edge that won't survive live capture.")
2. **Total OOS PnL strictly positive,** net of T0.3 slippage + fees. Sortino can look fine on a near-zero-PnL strategy; this is the necessary condition that actually maps to "makes money."
3. **P95 per-trade loss ≤ 30% of position size.**
4. **n ≥ 200 closed trades** for the variant being judged (see sample-size rule below).
5. **Window ≥ 14 days AND contains ≥ 1 detected meta shift** (see definition below).

### Meta-shift definition (observable, decided now)

A meta shift occurred within the window if either:
- **(a)** the T1.3 drift lane (`lib/workers/drift-monitor.ts` → `drift_metrics.meta_shift`) records **PSI > 0.25** on any monitored feature, baseline = first 3 days of universe snapshots; OR
- **(b)** a documented external pump.fun mechanic / fee change is dated within the window.

*Monitored feature vector (pinned for reproducibility):* PSI is computed on the UNBIASED universe sampler (`feature_snapshots`, `sample_source='universe'`) over `dex_vol_m5`, `dex_liq_usd`, `grad_score`, `dex_buy_sell_ratio`, `unique_buyers_5m` — the market-regime signals (volume, liquidity, maturity, order-flow, buyer breadth). The universe sampler is used rather than the traded population because meta-shift is a property of the market, not of our selection; these are the unbiased-population equivalent of the cohort signals (`dexBuysM5`/`smartMoneyCount`/`entry_mcap_usd`) that separated winners from duds. `positive_label_rate` drift is tracked as a secondary regime signal.

If neither occurs by day 14, extend the window until one does (hard ceiling **30 days**), then read the result.

### Sample-size conflict rule

Run the window until the most restrictive decision-relevant variant (V6) reaches **n ≥ 200**, capped at **30 days**. If V6 hasn't reached 200 at the cap, mark it `directional only (n<200)`; keep/cut decisions lean on variants that did reach 200, and V6-vs-best-simpler is reported with its CI but **not treated as conclusive**.

### Decision rules (locked now, applied at end of window)

- **Q1 — Does an edge exist?** If no variant clears conditions 1–5 → **trading thesis falsified, live path closed.** The defensive rug model (T5.1) can ship independently and retains standalone value.
- **Q2 — Is the complexity earning its keep?** Marginal rule: keep a subsystem only if it moves Sortino OR cuts P95 tail loss by a margin clearing the bootstrap 95% CI. Else **demote** (log the score as a feature for future models), don't delete.
- **The uncomfortable pre-commit:** if V6 ≈ V1 within bootstrap 95% CI, the apparatus between them gets **frozen or deleted.** 325 files matching a 200-line baseline = pure liability that costs maintenance, bug surface, and cognitive load for no measured benefit. This will feel like throwing away work. It isn't — it is converting a maintenance burden into a known, simple, trustworthy system.
- **Cut-bias disclosure:** the marginal rule + finite sample means a genuine but small effect can fall below detection and get cut. Stated policy: we keep only what we can prove helps at this n; anything cut for insufficient power is **demoted (not deleted as proven-useless)**, flagged for re-test at larger n.

### How this is enforced

- The T4 ablation report (`scripts/ablation-report.ts`, to be built) computes Sortino with the formula above and emits explicit `PASS` / `FAIL` against conditions 1–5 plus the marginal/uncomfortable rules. No threshold the operator types after the fact; the report's verdict IS the decision.
- The T1.3 drift lane (`lib/workers/drift-monitor.ts`, to be built) provides the meta-shift detector that condition 5 references. The kill-gate is unverifiable without it.
- The T0.3 honest slippage model is a hard prerequisite: PnL in the kill-gate equation must be net of the brutal slippage, not the legacy 8%-capped figure.

### The explicit NO condition

If conditions 1–5 are not all met across a window with a detected meta shift:
1. The live path (Tier 6 of the v2 plan) does not open.
2. The 325-file apparatus is treated as instrumentation/research code, not as a profit engine.
3. T5.1 (defensive rug model) ships standalone — it has value independent of the trading outcome.
4. This file gets a `Kill-gate result: FAIL (date)` note appended here, with the variant table that produced the verdict. No re-runs to "give it another chance" without first identifying what changed in the upstream input that justifies it.

### Holding the discipline

The single most protective thing in this whole project is the operator's willingness to **believe a red number**. Every other safeguard — control sampler, OOS walk-forward, post-exit telemetry, bootstrap CIs — exists to produce a trustworthy number. They are wasted if the number is then re-interpreted in the operator's favor. The plan front-loads cheap kills (T3.1, T3.2 in Sprint 1b) precisely so a "no" answer arrives for a few hours of SQL instead of months of infra. Treat a red number as a successful experimental result. That is what the apparatus is for.

---

## 9. Reconciliation notes (plan assumptions vs. verified as-built state)

Recorded so the next dev doesn't trip on a stale assumption. Verified against the code in Part I.

- **`lib/continuation/archetype.ts` is NOT a stub** — it is already a working classifier returning `launch_early | migrated_breakout | dex_parabolic | exhaustion | thin_liq` from liquidity, `priceChangeH24`, Engine-B state, and exhaustion probability. Phase 4 should **extend** it (add the insider-heavy / wash-trap / slow-grinder / exhausted-runner archetypes and wire `hist_win_dist`), not build from zero.
- **`FAST_LANE` is referenced in code but not yet wired.** `lib/intelligence/fast-lane.ts` is a pure, tested core (decision + dedup + bounded queue); the `FAST_LANE` env flag it mentions is **not** in `lib/env.ts`'s Zod schema, and it is not connected to the live ingestor/executor. "Make it explicit" (§2) means: add the env key, then wire HOT → enqueue → executor with the audit write async.
- **Issue #11 is confirmed accurate** — `paper_portfolio` is a CHECK-enforced `id=1` singleton and the auto-trader's `handleExits` manages *every* OPEN `paper_positions` row regardless of owning session (it has to, or an orphaned position holds the global `maxConcurrent` cap forever). Per-session attribution today is via `entry_features.session_id`; Phase 0/1 should make OPEN-position ownership explicit rather than inferred from JSONB.
- **Issue #6 is confirmed** — `mineLossPatterns`/`mineWinningPatterns` (`lib/db/repos/loss-learning.ts`) do single-feature threshold splits. Keep their output as a *feature* into the Phase-3 model rather than deleting them.
- **`IntelligenceTruthViewer` exists** at `components/IntelligenceTruthViewer.tsx` (top-level, not under `components/mission/`) — Phase 6 narration should target it there.
- **Retention today** (`EVENT_RETENTION_DAYS`, default 7) runs via `lib/db/retention.ts` as row deletes; Phase 0's partition-drop is a net new mechanism, not a modification of the current path.

---

---

# Part III — Session 2026-06-15 additions

> Appended after the strategic dive that produced (a) the entry-quality tightening, (b) the post-exit telemetry pipeline, and (c) the genesis-sniper entry path. Read this in addition to Part I (as-built reference) and Part II (forward plan) — the items here are **shipped** code, not plan.

## III.1 Strategic insights from the deep-dive

Verified from the DB across sessions 30 (320 closed) + 31 (87 closed) + the 27,493-mint backtest across 3 days.

| Insight | Evidence | Implication |
|---|---|---|
| **The strategy buys at the wrong curve regime.** | 81% of our entries are vSol 113+ (post-grad); 87% of 115 elite wallets play vSol < 60 (pre-grad). 6,133 elite buys, median entry 29.2 vSol, 22s median hold. | Built genesis-sniper to enter the proven-winning regime (see III.3). |
| **Trail captures only 23% of winner peak.** | 18 trail+tp1 winners: peak +30.2% vSol (= +72.5% value) but realized only +16.7%. | Exit policy is the next-biggest lever — deferred until post-exit data flows; can't tune blind. |
| **Winner/loser ratio = 0.86 means we need 54% win rate to break even.** | 97 closed: avg winner +10.2%, avg loser −11.8%. Current win rate 38%. | Either ratio (bigger wins) or rate (better entries) must improve. Genesis-sniper + future trail-widening address both axes. |
| **Smart-money detector surfaces wrong wallets.** | smc≥2 trades averaged −18% (n=5 — small but consistent direction). 88 elite wallets exist (t_stat>3, avg_return>50%). | Tighten smart-money definition. Deferred — sample too thin to act safely yet. |
| **Two of three user-nominated "winning" wallets are invisible to us.** | Zero events in our DB. The one verifiable winner trades exclusively on PumpSwap post-grad. | PumpSwap ingestion is the path to learn from post-grad winners — ~1 day arch work. Deferred. |
| **Activity floor lifted win rate 27% → 37%, but per-stop loss grew 2.5×.** | Session 30 stops avg −0.0087/SL; session 31 stops avg −0.0215/SL. Coins selected are higher-activity → higher volatility. | SL tighten 0.15 → 0.12 addresses this incrementally (III.2.3). |
| **The confluence gate doesn't separate winners from losers.** | gateConfidence: winners 0.55 vs losers 0.55 (×1.05). | Real signal is in `dexBuysM5`, `smartMoneyCount`, `entry_mcap_usd` (each 4–6× separation). |

## III.2 Entry-policy tightening (data-driven)

### III.2.1 Entry-activity floor — `ENTRY_MIN_DEX_BUYS_M5`
**Location:** `lib/env.ts` (schema) + `lib/workers/auto-trader.ts` (in `handleEntries`, right after `analyzeMintInsiders`).

**Rule:** For DEX-flow coins (where `dexSnap` is present), require `(dexBuysM5 ≥ 40) OR (smartMoneyCount ≥ 1)`. Pure-bonding-curve newborns with no DexScreener data bypass this floor (and are now also caught by the new genesis-sniper path — III.3).

**No momentum gate.** Earlier attempt (`dexPriceChangeM5 ≥ 0`) was reversed: on the larger 40-mover sample, winners actually had **negative** 5m change at entry (−0.49% vs +0.62% on duds). Buying coins already pumping = buying the local top. Env key removed in code; only `ENTRY_MIN_DEX_BUYS_M5` remains.

**Backtest:** lifts session-30 sample from 27% → 53% win, −0.30 → −0.01 SOL (combined with the mcap tightening below).

### III.2.2 `MAX_ENTRY_MCAP_USD` tightened 150k → 60k
**Location:** `.env.local`.

**Why:** Winners avg entry mcap $55k, losers $85k (clear separation across 283 cohorted trades). Tightened to push entries into the regime where the data says we win.

### III.2.3 Balanced preset `stopLossPct` 0.15 → 0.12
**Location:** [`app/api/auto/quick-start/route.ts`](../app/api/auto/quick-start/route.ts) `PRESETS.balanced`.

**Math:** −12% vSol = −22.6% value (curve PnL is quadratic) vs prior −27.75% value. Saves ~−0.005 SOL/stop. Backtested against 87-trade session 31 → projected session loss −0.470 → ~−0.37 SOL.

**Why not tighter (e.g. 0.10):** trail+tp1 winners went straight up (no drawdown), so a tighter stop wouldn't cost wins — but timeout trades drift through −10% before recovering, and a 0.10 SL would convert some of those to losses. 0.12 is the conservative step; tighten further if the next session still shows SL bucket dominating losses.

## III.3 Genesis-sniper entry path

The big architectural addition. New parallel entry path that targets the regime elite wallets actually play in.

### III.3.1 Why
Our existing `handleEntries` chain (`qualifyEntry` + `MAX_ENTRY_MCAP_USD` + the activity floor) **mechanically rejects fresh-curve mints** — DexScreener has no data on a 30s-old coin, and pump.fun mcap is sub-$5k. Result: 81% of our entries are at vSol ≥ 113 (post-grad), while 87% of elite wallets play vSol < 60. We needed a path that can buy *before* the existing chain even sees the mint.

### III.3.2 Components
| File | Role |
|---|---|
| `lib/intelligence/genesis-snipe.ts` | Pure decision function `evaluateGenesisSnipe(signal, cfg) → {fire, reason, confidence, vSolBucket}`. No IO; trivially testable. |
| `lib/db/repos/genesis-signals.ts` | Data fetcher `fetchGenesisSnipeCandidates({maxAgeSec, limit})` — pulls curve-activity in the last 30s for fresh-created mints. **Clock-jump-safe** (anchored to latest event ts, not `now()`). |
| `lib/workers/auto-trader.ts` `handleGenesisEntries` | Parallel entry function. Runs BEFORE `handleEntries` each tick. ~115 lines, paper-only, env-gated. |
| `lib/env.ts` | New env vars (below). |

### III.3.3 Decision algorithm (two-stage)

**Stage 1 — hard gates** (cheap cuts before scoring):
- `ageSec ∈ [5, 60]`
- `currentVSol ∈ [18, 60]` (the proven-winning zone)
- `buys30s ≥ 4`
- `uniqueBuyers30s ≥ 3`
- buy/(buy+sell) volume ratio ≥ 0.55

**Stage 2 — composite velocity** via the existing pure `scoreLaunchVelocity` (Part I §11). Requires `score ≥ 0.35` and no hard veto.

Defaults derived from the 115-elite-wallet pattern (median entry vSol 29.2, p25–p75 18.8–42.0).

### III.3.4 Backtest validation
Run against 27,493 mints created in the last 3 days. Backtest evaluated the gates at each mint's `create_ts + 30s` and looked at the max vSol within `+30s … +5min`.

- **Would-fire: 7.7% (2,110 mints)** — sensible selection rate
- Of those, **50% pumped ≥+20%** within 5 min (vs random baseline 29.8%) — 1.7× edge
- **34% pumped ≥+50%** — 1.5×
- **23% pumped ≥+100%** — 1.4×
- **8% pumped ≥+500%** — much higher than random
- Projected per-trade expectancy (30% capture rate, conservative): **~+16%** vs current −0.5%

Limitations: backtest is in-sample, the +1600% avg is skewed by extreme outliers (some genesis vSol≈1 entries), and real capture depends on exit policy.

### III.3.5 New env vars
```
GENESIS_SNIPER=off              # opt-in only; default off
GENESIS_SNIPER_SIZE_SOL=0.02    # small bet; high-variance strategy
GENESIS_SNIPER_MAX_AGE_SEC=60
```

### III.3.6 Trade entry features stamped
Every genesis trade gets `entry_features.genesis_snipe=true` plus:
- `genesis_confidence` — the velocity score
- `genesis_bucket` — `genesis|very_early|early|mid|late|post_grad` based on entry vSol
- `genesis_buys_30s`, `genesis_sells_30s`, `genesis_unique_buyers_30s`, `genesis_buy_sell_ratio`, `genesis_buy_vol_sol_30s`

Lets the learner attribute outcomes cleanly back to genesis vs regular entries.

### III.3.7 Guardrails
- **Paper only** — `session.mode !== "paper"` returns immediately. Real-money disabled.
- **Default off** — env flag opt-in.
- **Small default size** — 0.02 SOL.
- **Wrapped in try/catch** in the tick loop — a failure here cannot break the regular `handleEntries`.
- **Respects global cap** — uses same `entryHeadroom` capacity check as `handleEntries`.
- **Held-mint dedup** — won't open the same mint twice.

### III.3.8 Known limitation — exit policy not genesis-tuned
Genesis trades use the same SL/TP/trail as regular trades. The data says genesis winners run +20% → +50,000% in 5 min, but our current trail will cut them at ~+17%. **The first genesis session will reveal whether the signal is good; exit-tuning comes after we have the post-exit data (III.4) to make that decision evidence-based.**

## III.4 Post-exit telemetry pipeline

We had a blind spot: after we sell a coin, we never look at what it does next. So we don't know if our stops are saving us from rugs or cutting off recoveries. This shipped today.

### III.4.1 Components
| File | Role |
|---|---|
| `lib/db/repos/measurement.ts` | New `recordPostExitSnapshot({mint, positionId, exitVSol, exitMcapUsd, exitReason})`. Writes `feature_snapshots` row with `sample_source='post_exit'`, `ref_v_sol=exit_price`, `ref_mcap_usd=exit_mcap`. New `sampleSource` literal includes `'post_exit'`. |
| `lib/workers/auto-trader.ts` | Called from both paper close paths (`timeout_stale` force-close and the main exit). |
| `lib/workers/label-builder.ts` | **Modified** to skip `sample_source='post_exit'` rows — the new poller handles them (events table is empty for graduated coins). |
| `lib/workers/post-exit-poller.ts` | New worker. Every 60s, finds post-exit snapshots whose horizons matured, polls pump.fun API for current mcap, patches `outcome_labels.ret_5m/30m/1h/6h`. At 6h, finalizes with `max_gain_pct`, `max_drawdown_pct`, `is_rug`, `is_breakout`. |
| `lib/workers/orchestrator.ts` | Registered after `startLabelBuilder()` so both run in parallel. |

### III.4.2 Why pump.fun API instead of events table
The label-builder reads from `events` (bonding-curve trades). But the coins we trade often graduate within minutes of our exit — and once graduated, `events` has nothing. Confirmed empirically: only **1 of 92** session-31 closed mints had any post-exit event data. `mint_dex_quotes` is also empty (only fills when someone views the chart). The pump.fun API sees graduated mcap → it's the only realistic free data source for post-exit tracking.

### III.4.3 Per-tick algorithm
```
For each due post-exit snapshot:
  Determine youngest unfilled horizon column (ret_5m → ret_30m → ret_1h → ret_6h)
    where age_sec >= horizon_secs AND column IS NULL
  If found AND refMcap > 0:
    coin = fetchPumpFunCoin(mint)
    If coin.usdMarketCap > 0:
      ret = coin.usdMarketCap / refMcap - 1
      patchRet(snapshotId, column, ret)  // idempotent UPSERT keyed on snapshot_id
  If age_sec >= 6h:
    finalize(snapshotId) — compute max_gain_pct, max_drawdown_pct from the 4 horizon values, mark horizons_complete=true
```

### III.4.4 Rate-limit safety
pump.fun fetches have an 8s TTL cache. Worst case: ~5–10 polls/minute. Well within free-tier limits. Worker tick is 60s.

### III.4.5 What we'll be able to ask after a session
- "Of trades we exited via `sl`, what % had positive forward returns at T+1h?"
   - High → our stop is too eager, recoveries happen after we sell
   - Low → our stop is correctly saving us from bag-holding
- "Of `trail+tp1` winners, what was the avg max_gain after exit?"
   - High → we're selling too early
   - ~0 → coins reverse after our exit, our timing is right
- "Of `timeout` exits, what % went to is_rug=true within 6h?"
   - High → timeout exits are saving us from continued bleed
   - Low → we should hold longer

This is what makes future exit-tuning **evidence-based**, not opinion.

## III.5 Bug fixes shipped this session

### III.5.1 UI position counts (`stats.openCount` / `stats.closedCount`)
**Location:** `lib/auto/session-positions.ts` `fetchAutoSessionPositions`.

**Bug:** The function ran one `LIMIT 30` SQL query for both open + closed, then counted the lengths of the resulting arrays as `openCount`/`closedCount`. Once a session exceeded 30 trades, `closedCount` was always capped at `30 - openCount` (so the UI showed "Closed 25" when reality was 316).

**Fix:** Separate cheap `COUNT(*) FILTER (WHERE status='open|closed')` query for true session-wide totals. The paginated list arrays stay for display. Case-sensitivity gotcha: `PAPER_TRADES_READ` view returns status lowercase (`open`/`closed`), not `OPEN`/`CLOSED` like the underlying `state` column.

**Verified live:** API returned `openCount: 5, closedCount: 316` matching DB truth (after wiping `.next/cache` to clear a stale webpack pack).

### III.5.2 Migration marker on wrong candle
**Location:** `lib/chart/data/graduation.ts` `migrationTimeFromCurve`.

**Bug:** The CompleteEvent (the on-chain migration event) never reaches our bonding-curve log subscription — it fires on the PumpSwap program. So our DB has 0 migrate events. The fallback path used pump API `lastTradeAt`, which is the coin's *latest* trade — putting the marker on the newest candle, not the migration candle.

**Fix:** Infer migration moment from the curve crossing: first `events` buy/sell with `v_sol_after >= CURVE_COMPLETE_V_SOL (113)`. The hard cap is ~115 vSol (validated against 283 graduated coins); 113 leaves margin.

**Critical pg gotcha discovered:** `EXTRACT(EPOCH FROM MIN(ts))*1000` returns Postgres `numeric`, which the pg driver returns as a JS **string** — so `Number.isFinite("…")` is false and the function silently returned null. Fixed with `::float8` cast in the SQL.

**Verified:** `133DqGsg…pump` now returns `2026-06-08T13:10:12Z` (the real migration moment, ~$40-69k mcap).

### III.5.3 A2 real-time chart tail
**Location:** `lib/chart/runtime/chartRuntime.ts` `hydrateGraduatedCandles`.

**What:** Overlays fast on-chain quotes (from chart-onchain-quote-lane, source `onchain`, ~2s cadence) onto Gecko's slower (~20s) recent candle history. Older candles stay as-is (Gecko finalized history); only the forming tail uses on-chain for freshness.

**Verified at logic layer:** `quotesToCandles` produces tf-aligned buckets matching Gecko's times; overlay replaces matching buckets without duplicates; older Gecko candles survive (only the tail flips to on-chain).

**Not yet live-verified:** `source='onchain'` rows = 0 in DB (the A1 quote lane only writes when a graduated chart is open in the browser AND the worker is running). End-to-end live confirmation pending.

## III.6 Logic & behavior — supposed vs actual (cross-cutting)

Where the design's intent differs from current behavior. Treat as the operator's debug map.

| System | Supposed | Actual | Severity |
|---|---|---|---|
| Entry filter | Selects best entries across regimes | Mechanically forces post-grad regime (81% post-grad entries) | **High** — root cause of poor returns; addressed by genesis-sniper |
| Exit logic | Lets winners run, cuts losers fast | Cuts winners at ~+17%, lets losers reach −15% | **High** — addressed by future trail-widening once post-exit data lands |
| Smart-money detector | Surfaces real alpha wallets | Surfaces noisy wallets (low t-stat threshold) | Medium — 88 elite wallets exist but unused in entry decisions |
| `events` table | Comprehensive trade history | Bonding-curve only; entire DEX universe invisible | Architectural — fixing requires PumpSwap ingestion |
| `mint_dex_quotes` | Continuously populated for active mints | Only fills when a chart is open in browser | Medium — limits what label-builder can see |
| Learner | Continuously adapts gates | Dormant (`AUTO_TUNE=off`) for clean measurement | Intentional |
| Genesis-sniper | New entry path matching elite-wallet pattern | Wired, backtest-validated, **unproven live** | New |
| Post-exit poller | Track every closed trade's forward returns | Wired, no data accumulated yet | New |
| Chart pipeline (A2) | On-chain tail overlays Gecko in real time | Built, but `source='onchain'` rows = 0 in DB | Low |
| Migration marker | At the real migration candle | **Fixed today** — was at latest candle | Was bug |
| UI counts | True session totals | **Fixed today** — was paginated cap | Was bug |
| Confluence score | Predicts winners | Identical for winners/losers (0.55 vs 0.55) | Medium — feeds wrong-regime entries |
| Trail+TP1 booking | Quadratic curve PnL | Fixed earlier session — was linear `(exit-entry)·qty` | Was bug |
| Wallet vault | Worker-only AES-256-GCM scrypt | Works as designed | OK |
| Web→Worker write gate | All mutations through allowlist | Works as designed | OK |
| Circuit breaker | Global halt switch | Works as designed | OK |
| Kill switch | Pause entries on losing streak | Works as designed | OK |
| Boot logout | Restart = logged out | Works as designed | OK |

## III.7 Updated env-var index (new keys only)

Added this session — see `lib/env.ts` for the full Zod schema:

```
ENTRY_MIN_DEX_BUYS_M5=40        # Entry-activity floor; 0 disables. Replaces removed ENTRY_MIN_DEX_PRICE_CHG_M5.
GENESIS_SNIPER=off              # Genesis-sniper entry path (Part III.3). Opt-in only.
GENESIS_SNIPER_SIZE_SOL=0.02    # Small bet for high-variance genesis strategy.
GENESIS_SNIPER_MAX_AGE_SEC=60   # Mints older than this skipped by the sniper.
```

`.env.local` changes:
```
MAX_ENTRY_MCAP_USD=60000        # Tightened from 150000 (data: winners $55k, losers $85k entry mcap)
```

Preset change in `app/api/auto/quick-start/route.ts`:
```
balanced: { stopLossPct: 0.12, ... }   # Tightened from 0.15
```

## III.8 Updated worker enumeration

Add to Part I §22:
- **`post-exit-poller`** — every 60s, polls pump.fun API for forward returns of closed positions at 5m/30m/1h/6h horizons. Writes/patches `outcome_labels`. Registered in `orchestrator.ts` line ~109.

Modified:
- **`label-builder`** — now SKIPS `sample_source='post_exit'` rows (handled by `post-exit-poller`). Single-line filter added to `fetchMaturingSnapshots`.
- **`auto-trader`** — new `handleGenesisEntries(session)` function called BEFORE `handleEntries` each tick (~115 LOC added). New entry-activity floor in `handleEntries` body. `recordPostExitSnapshot` invocation in both paper close paths.
- **`graduation` data layer** — `migrationTimeFromCurve` now uses curve `v_sol_after >= 113` crossing (with `::float8` cast) instead of pump API `lastTradeAt`.

## III.9 Next-session experimental plan

The disciplined next steps after this session's work:

1. **Restart worker + dev** (Ctrl+C, optionally `rm -rf .next/cache`, restart both).
2. **Start a new auto-trade session** — balanced preset now uses SL 0.12, mcap cap 60k, activity floor 40 buys (no momentum gate).
3. **Optionally enable genesis-sniper**: set `GENESIS_SNIPER=on` in `.env.local` and restart worker. Will run alongside regular entries at 0.02 SOL/trade default size.
4. **Run 6–8 hours**, then pull:
   - Standard metrics (win rate, sum PnL, per-trade)
   - Genesis-sniper outcomes (filter `entry_features.genesis_snipe=true`)
   - Post-exit data (join `paper_positions` ↔ `feature_snapshots` ↔ `outcome_labels` on `decision_id`)
5. **Analyze**:
   - Did the activity floor's win-rate gain (27% → 37%) hold OOS?
   - Of genesis fires, what was win rate / per-trade?
   - Of SL-closed trades, what % had positive 1h forward returns? (decides whether to loosen or tighten SL next iteration)
   - Of trail+tp1 winners, what was avg max_gain_pct after exit? (decides whether to widen trail)
6. **Make ONE policy change** based on the strongest evidence, run another session, repeat.

Per karpathy discipline: one variable changed per session so each iteration's data is interpretable.

---

---

# Part IV — v2 Plan Sprint 1a + 1b results (2026-06-20)

> Records the outcomes of the v2 plan's first two sprints. Read alongside `~/.claude/plans/deep-nibbling-iverson.md`.

## IV.1 Sprint 1a — Tier 0 (DONE)

### T0.1 Postgres backup + safe-migrate
- Shipped four scripts: `scripts/backup-db.ps1` (daily `pg_dump` via Docker exec, custom format, 7-day rotation, OnDemand flag), `scripts/restore-test.ps1` (full restore round-trip + critical-table row-count verification), `scripts/safe-migrate.ps1` (snapshot → restore to temp DB → dry-run migration there → only then apply to live), `scripts/install-backup-schedule.ps1` (optional Task Scheduler installer for 03:00 daily).
- Verified end-to-end: 996MB compressed dump → restored successfully (events 2.9M, feature_snapshots 142k, outcome_labels 132k, wallet_profiles 93k all intact).
- **Operator action remaining:** run `./scripts/install-backup-schedule.ps1` to arm the daily Task Scheduler entry.

### T0.2 Kill-gate pre-registered
- See §8 above (`docs/SYSTEM_DESIGN.md` Part II §8). Per-trade Sortino formula, threshold 0.7, total OOS PnL > 0 necessary condition, P95 loss ≤ 30%, n ≥ 200, window ≥ 14d + meta shift (PSI > 0.25 from T1.3 OR external pump.fun mechanic event).

### T0.3 Honest slippage
- `packages/trading/src/slippage/index.ts`: impact cap raised 800 → **5000 bps**; docstring made the deterministic curve-impact math explicit. `slippage.test.ts`: 6/6 pass — 4 existing + 2 new T0.3 acceptance tests (5% pool consumption → > 8% end-to-end via quadratic; 50% pool consumption now correctly charges ~125% instead of the previously-clipped ~17%).

## IV.2 Sprint 1b — Genesis pivot validation (the decisive cheap kills)

### T3.2 PASSED decisively — `scripts/genesis-latency-analysis.ts`
Replayed `evaluateGenesisSnipe` against **291 elite on-curve entries** (40 wallets × up to 15 recent, vSol < 60). Vs the plan's pre-registered > 50% AFTER-elite-exit kill threshold:

| Metric | Value |
|---|---|
| Elite median hold | **18s** (plan's 22s estimate was close) |
| Our median detection latency (mint create → fire) | **10s** |
| Median fire-vs-elite-entry | **0s** (often ahead) |
| % firing BEFORE elite entry | **49.7%** |
| **% firing AFTER elite exit** | **1.4%** ⇒ **PASS (threshold was > 50%)** |

The most dangerous structural hypothesis (genesis pivot is still exit-liquidity-provider, just at a lower price) is **empirically rejected**. We fire at roughly the same moment as elite wallets on median.

### T3.1 FAILED-strict / PEAK-EDGE-POSITIVE — `scripts/genesis-oos-validate.ts`
Split a 6-day window into TRAIN [now-6d, now-3d] (in-sample reference) and TEST [now-3d, now] (untouched OOS, **1,429 mints, 367 fires**). T0.3 honest slippage applied to both legs. 2,000-iteration bootstrap CI.

**Two metrics — same data, different exit assumption:**

| | Genesis OOS | Random OOS | Edge | 95% CI |
|---|---|---|---|---|
| **Held-to-deadline median return** (5min hold, no trail) | −54.7% | −14.0% | **−40.7%** | [−46.0%, −33.5%] |
| **Peak-capture median return** (max-favorable-excursion) | **+36.5%** | −1.2% | **+37.6%** | **[+25.8%, +51.4%]** |
| Peak win-rate (any positive excursion) | **77.4%** | 45.5% | +32 pp | — |

**Interpretation:** The gates select coins with real upside — 77% of fires touch a positive peak within 5 min, vs 45% of random entries. Median peak is +36% on genesis vs −1% on random (CI [+25.8%, +51.4%], decisively positive). But the strawman "hold for the full 5 min with no trail-stop" exit catches the post-peak dump every time. This is the same **"trail captures 23% of peak"** failure pattern session 31 surfaced — now independently confirmed on OOS data with no shared methodology.

**Decision input (verbatim from the script):** the kill-gate verdict on genesis should **wait for T3.3** (genesis-tuned exits — laddered TP, tight rug-stop). The gate is not dead; the exit policy is the binding constraint. Per the v2 plan's gate-rule, the strict held-to-deadline edge fails — but the peak-edge diagnostic shows the failure is downstream of selection. T3.3 is now critical, not optional.

### Sequencing implication
The v2 plan's Sprint 5 had T3.3 as "only if T3.1+T3.2 passed". T3.2 passed; T3.1 produced a nuanced result (selection works, exit doesn't). T3.3 should proceed — its absence is exactly what made T3.1's strict metric fail. After T3.3, re-run T3.1 with the tuned exit before the T4 ablation.

---

## IV.3 Sprint 2 — T1.1 WS Gap Recovery (DONE 2026-06-20)

The v2 plan's measurement-integrity prerequisite. Without this, every label downstream of a WS drop is silently corrupted (a coin that pumped during a 20s hiccup gets a feature row saying "quiet" + a label from incomplete trades).

### Shipped
| File | Role |
|---|---|
| `drizzle/0022_ingest_gaps.sql` | Applied via `scripts/safe-migrate.ps1` (first real exercise — caught + fixed an `ErrorActionPreference='Stop'` bug in safe-migrate where Postgres NOTICE on stderr killed the script) |
| `lib/db/schema/ingest-gaps.ts` | `ingest_watermark` singleton + `ingest_gaps` log with partial index for unrecovered overlap lookup |
| `lib/db/schema/measurement.ts` | `outcome_labels.blocked_reason` column added |
| `lib/db/repos/ingest-gaps.ts` | `getWatermark`, `upsertWatermark` (monotonic), `openGap`, `closeGap`, `markUnrecoverable`, `gapOverlaps`, `openGapCount` |
| `lib/ingest/gap-recovery.ts` | Pure `recoverGapForMints(rpc, gap, mints)` with per-mint failure isolation, MAX_SIGNATURES_PER_MINT=500 cap, RpcClient DI interface |
| `lib/ingest/gap-recovery.test.ts` | 8/8 tests pass — empty/inverted/slot-window/failure-isolation/pagination-termination/untilSig/safety-cap |
| `lib/rpc/http-client.ts` | Minimal `RpcClient` adapter via fetch() to Solana JSON-RPC (no @solana/web3.js dep) |
| `lib/rpc/ws-manager.ts` | Tracks lastSlot/lastSig HWM on every notification; snapshots on disconnect; emits `onReconnect` AFTER re-subscribe (skips first connect) |
| `lib/workers/ingestor.ts` | Watermark persisted on each flush; `handleReconnect` computes gap via getSlot, scopes at-risk mints (`feature_snapshots` horizon-overlap UNION open `paper_positions`, joined to `events.raw->>'bondingCurve'` for PDA), fires async `recoverGapForMints`, inserts recovered events via `insertEvents` ONLY (skips chart push / tokens / launch-hot — backfilled events must not stream); MAX_RECOVERABLE_GAP_SEC=300 |
| `lib/workers/label-builder.ts` | `gapOverlaps` gate at start of `labelOne` — writes `blocked_reason='gap'` with `horizons_complete=false` so a later pass re-attempts after recovery |
| `lib/auto/diagnostics.ts` | `ingestGapsOpen: number` surfaced via `openGapCount()` for live ops visibility |

### Acceptance criteria (per v2 plan T1.1)
| Criterion | Status |
|---|---|
| ✔ trades during forced WS drop+reconnect land in `events` for tracked mints within recovery window | Pending live operator verification (kill+restart worker, watch logs) |
| ✔ every gap → an `ingest_gaps` row | Verified via integration script |
| ✔ no `outcome_labels` row computed over an unrecovered gap | Verified — gapOverlaps gate correctly detects overlap windows |
| ✔ diagnostics shows open-gap count live | Verified — `openGapCount` returns correct count |
| ✔ no chart "oldest data" errors from backfill | Pending live operator verification (backfilled events skip chart push by design) |

### Tier 0 + Sprint 1b + T1.1 cumulative state (2026-06-20)
- T0.1 backup + safe-migrate: shipped, daily backup verified (996MB→restore PASS)
- T0.2 kill-gate: locked at Sortino ≥ 0.7 / OOS PnL > 0 / P95 ≤ 30% / n ≥ 200 / window ≥ 14d + PSI > 0.25 meta-shift
- T0.3 honest slippage: shipped, cap 800→5000 bps, end-to-end PnL impact correctly magnified through curve quadratic
- T3.2 latency vs elite entry: **PASSED** — 1.4% AFTER elite exit (kill threshold > 50%)
- T3.1 OOS gates validation: **FAILED strict, peak-edge +37.6% with CI [+25.8%, +51.4%]** — exit policy is the binding constraint, T3.3 critical
- T1.1 WS gap recovery: **DONE** — labels can no longer be computed over corrupted event windows

Next per the v2 plan: **Sprint 3 — T1.2 PumpSwap ingestion** (the highest-leverage build).

---

## IV.4 Sprint 3 — T1.2 PumpSwap ingestion (DONE 2026-06-21)

The report's single highest-leverage build — removes the architectural blindness where `events` was bonding-curve only, so the entire post-graduation DEX universe was invisible (causing 4 downstream problems: learner bias, smart-money mining the wrong wallet population, label-builder unable to label graduated coins on-chain, post-exit-poller forced to API-scrape).

### Discovery (T1.2a) — validated, no guessed offsets
- **Program:** `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA`
- Swaps surface as Anchor `emit!` → `Program data:` lines. `BuyEvent` disc `67f4521f2cf57777` (385B), `SellEvent` disc `3e2f370aa503dc2a` (352B).
- Full byte layout decoded + **cross-validated against on-chain SOL/token balance deltas** for 4 real txs. See `lib/pump/__fixtures__/PUMPSWAP_LAYOUT.md` + `pumpswap-swaps.json`.
- **Key subtlety:** the event type is the POOL's action, not the user's. `userSide = (BuyEvent && base≠WSOL) || (SellEvent && base==WSOL)`. Requires pool→mint resolution (immutable, cached).

### Shipped
| File | Role |
|---|---|
| `lib/pump/program.ts` | `PUMP_SWAP_AMM_PROGRAM`, `WSOL_MINT`, `PUMP_SWAP_DISCRIMINATORS` |
| `lib/pump/pumpswap-parser.ts` | Pure `parseSwapLogs` (fixture-tested, decode-isolated) + `enrichSwap` (base/quote→SOL/meme + user side) + `effectiveVSolFromReserves` (SOL-price-independent: `sqrt(price·SUPPLY·CURVE_DIV)`) |
| `lib/pump/pumpswap-parser.test.ts` | 13/13 — 4 real fixtures to exact fields + side + amounts, effVSol round-trip, isolation tests |
| `lib/pump/pool-registry.ts` | `resolvePoolInfo`/`resolvePoolInfoBatch` — pool→{memeMint, baseIsWsol}, cached forever |
| `lib/db/schema/events.ts` + `drizzle/0023_events_venue.sql` | `venue` (default 'curve') + `pool` columns + venue-aware indexes; applied live via safe-migrate (all 2.9M existing rows → 'curve') |
| `lib/db/repos/events.ts` | `insertSwapEvents` (venue='pumpswap', dedup on sig+logIndex) |
| `lib/workers/ingestor.ts` | Second `WsLogsSubscriber` on the PumpSwap program (env-gated `PUMPSWAP_INGEST`, default off); buffered raw events → batched pool-resolve + enrich + effective-vSol in flush so the WS callback never blocks on RPC |
| `lib/env.ts` | `PUMPSWAP_INGEST` gate |
| `lib/chart/data/graduation.ts` | `migrationTimeFromCurve` guarded `venue='curve'` (a pumpswap event must never be mistaken for the curve-completion crossing) |
| `lib/workers/bot-detector.ts` | Wallet-PnL aggregation explicitly spans both venues (with a DO-NOT-add-curve-filter comment — this is where the survivorship-bias fix lands) |
| `lib/workers/label-builder.ts` | forwardOutcomes now spans both venues → graduated coins get real on-chain forward returns (was the "DEX labeler is a follow-up" gap) |

### Verification (T1.2f) — real data through the production path
Pushed 30 real PumpSwap swaps for the seed wallet `7Ts3yn7m` through the exact production pipeline:
- Wallet went **0 → 30 pumpswap events** (7 mints) — previously invisible, now visible.
- Cross-venue PnL: pumpswap sol_in 134.40 / sol_out 402.48 = **+268 SOL net** — exactly matching the standalone Helius analysis from earlier this session that our DB could not see. The "elite wallets finally visible" win, demonstrated.
- `migrationTimeFromCurve` still curve-only; 2.9M curve rows untouched. Full suite **199/199**.

### Operator step + follow-up
- **To enable continuous live ingestion:** set `PUMPSWAP_INGEST=on` in `.env.local` + restart `pnpm worker`.
- **T1.2g (deferred):** PumpSwap gap recovery (per-pool signature replay on reconnect) + post-exit-poller on-chain preference. Until it lands, a graduated-coin label spanning a PumpSwap WS drop could be incomplete. Lower urgency (post-grad labels are new; genesis strategy is pre-grad).

### Cumulative v2-plan state (2026-06-21)
Sprint 1a (T0.1/T0.2/T0.3) ✅ · Sprint 1b (T3.2 PASS / T3.1 peak-edge +37.6%) ✅ · Sprint 2 (T1.1 WS gap recovery) ✅ · **Sprint 3 (T1.2 PumpSwap ingestion) ✅**.

## IV.5 Sprint 3.5 — T1.3 drift / meta-shift detector (DONE 2026-06-21)

Makes the kill-gate's "window spanned ≥1 meta shift" condition (§8) verifiable instead of opinion.

| File | Role |
|---|---|
| `lib/intelligence/drift.ts` + `drift.test.ts` | Pure PSI (`computePSI` via baseline-quantile binning + epsilon floor), `metaShiftDetected` (>0.25). **8/8 tests** (identical→0, clear shift→>0.25, mild→<0.25, monotonic, edge cases). |
| `lib/db/schema/drift-metrics.ts` + `drizzle/0024_drift_metrics.sql` | `drift_metrics` (per-feature PSI jsonb, max_psi, meta_shift, positive_label_rate, baseline/current N). Applied via safe-migrate. |
| `lib/workers/drift-monitor.ts` | 10-min lane: PSI of the core vector on the UNBIASED universe sampler (recent 24h vs first-3-day baseline) → `drift_metrics`. `latestDrift()` for diagnostics. Registered in orchestrator. |
| `lib/auto/diagnostics.ts` | `AutoDiagnostics.drift` surfaces `{maxPsi, metaShift, computedAt}`. |

**Monitored vector** (unbiased universe-sampler equivalents of the cohort signals): `dex_vol_m5`, `dex_liq_usd`, `grad_score`, `dex_buy_sell_ratio`, `unique_buyers_5m`. Universe sampler (not traded population) because meta-shift is a market property, not a selection one. Kill-gate §8 reconciled to this exact vector.

**Verified on real data:** PSI computes interpretable values and **detected a genuine meta-shift** — `dex_vol_m5` PSI = 0.2674 (>0.25) between the baseline and a later window. The lane writes rows automatically once the snapshotter has fresh last-24h universe data.

## IV.6 Sprint 4 — chart fixes (DONE 2026-06-21)

Cheap, parallel-safe; addresses the original "chart is slow / fixes don't stick" complaint.

- **T2.1 — snapshot-authority version guard** (`components/chart/chartStore.ts`). `applySyncSnapshot` now drops a SYNC_SNAPSHOT that isn't strictly newer than current state (monotonic `(epoch, lastTradeId)`): older epoch → drop; same epoch behind → drop; newer epoch → accept (worker-restart reset); same epoch at/ahead → accept. Fixes the "fix lands then reverts" bug where a stale snapshot built before a live advance overwrote client state. **4 new tests** (drop-stale, accept-ahead, accept-newer-epoch, drop-older-epoch).
- **T2.2 — collapse the polling stack** (`components/chart/TradingChart.tsx`). The 1.5s on-chain `/live-price` poll now backs off to 3s when the WS is connected (WS already pushes fresh prices), keeping 1.5s only as the WS-down fallback — frees the Helius budget the ingestor competes for.
- **T2.3 — cache the stitched build** (`app/api/tokens/[mint]/chart-state/route.ts`). 2s TTL `cached()` around `buildSyncSnapshot` coalesces rapid/concurrent polls. *Deliberate deviation* from the doc's "key on last_trade_id + checkpoint-authoritative": the live DEX tail can't be cached by trade_id (post-grad it freezes while Gecko/on-chain keep updating), so a short time-based cache below the data's own refresh cadence is the correct safe version. Also confirmed `buildSyncSnapshot` already does incremental tail-replay via the in-memory `ChartMintCache` (not a full rebuild as the doc implied).
- **T2.4 (deferred):** upstream candle-ordering fix — needs a live ~1h session to instrument the violations `CandleSeries.sanitizeAscending` catches.

## IV.7 Sprint 5 — T3.3 genesis exits (DONE 2026-06-21) — the data reversed the plan

**T3.3a backtest (`scripts/genesis-exit-backtest.ts`) refuted the plan's premise.** Replaying 367 OOS genesis fires through 9 candidate exit policies (honest slippage, curve quadratic):

| Policy | median | mean | win% | **total SOL** |
|---|---|---|---|---|
| **A strawman (hold 5m, no trail)** | −54.7% | +458% | 18% | **+33.6** |
| B SL-15% only | −31.9% | +322% | 11% | +23.7 |
| C trail (best) | −21.5% | +0.2% | 26% | +0.01 |
| D ladder (best) | −21.8% | +7.4% | 26% | +0.54 |

Every laddered/trail policy **improves the median + win-rate but destroys total return** (33.6 → ~0.5) — they clip the moon tail. **Concentration probe:** the strawman's +33.6 SOL is **69% one trade** (a +116,571% coin), top-3 = 95%, drop-top-3 → +1.67 SOL (breakeven). The genesis edge is moon-tail-dominated — exactly the bimodal-distribution trap the report warned about: *don't optimize the median when the tail is the strategy*.

**The measurement backbone earned its keep** — it caught a "this looks profitable" that is actually one lottery ticket, and proved the planned "capture >30% of peak" exit-tuning would have *reduced* returns.

**T3.3b shipped the minimal evidence-based exit** (user-chosen): genesis trades (`entry_features.genesis_snipe`) now use a **wide rug-cut SL only** — `GENESIS_EXIT_SL_PCT=0.40`, no TP (`+Infinity`), no trail, no stagnation, no TP1 ladder; hold to `GENESIS_EXIT_MAX_HOLD_MIN=5`. Bounds per-trade loss while preserving the moon branch. The OPPOSITE of the plan's laddered design. `lib/env.ts`, `lib/workers/auto-trader.ts handleExits`, +3 tests in `exit-decision.test.ts`.

**The open question — is the genesis tail-edge real or lucky? — is now explicitly a T4-ablation question** (needs n≥200 + a meta-shift window; one 3-day window with one 1000x cannot answer it).

## IV.8 Sprint 6–7 — T4 subtractive ablation (harness DONE + first result, 2026-06-21)

The decisive experiment. **Architecture deviation (documented):** instead of a live parallel-shadow harness, the ablation runs OFFLINE over the recorded `feature_snapshots` + `outcome_labels` population — the same snapshots for every variant (zero time confound), deterministic, reproducible, and **runnable now** on the 13.7k already-matured labels (no build-then-wait-weeks).

| File | Role |
|---|---|
| `lib/env.ts` | `ABLATION_VARIANT` (V0..V6), `ABLATION_MODE` |
| `lib/intelligence/ablation-router.ts` + test | Pure `variantEnters(variant, features, id)` — V0 seeded-random floor → V6 `_auto_trade_allowed`. One switch, not forks. **7/7 tests.** |
| `scripts/ablation-report.ts` | Offline evaluate+report: per-variant Sortino/win/median/total/p05, adjacent deltas w/ bootstrapped CIs, kill-gate verdict, Q1/Q2. (No `ablation_trades` table — offline is deterministic; persistence only needed for the deferred live-shadow mode.) |

**Return-artifact guard:** raw `ret_1h` mean was ~1e17 (tiny-refVSol → `(v/ref)²` explodes). Capped realized return to `[−1, +100]` (−100%..+100×, the practical capture ceiling); 1h-hold exit held constant across variants so the comparison isolates ENTRY selection.

### PRELIMINARY RESULT (13,763 labeled universe snapshots — directional, partial window)

| Variant | n | win% | total | |
|---|---|---|---|---|
| V0 random | 3380 | **25.2%** | +709 | the floor |
| V1 intelligence | 8824 | 32.0% | +2768 | |
| **V2 +rug veto** | 4605 | **43.6%** | +2454 | ← best win-rate |
| V3 +M1/M2/M4/M5 | 4572 | 43.9% | +2454 | = V2 (modules add nothing) |
| V4 +grad floor | 1502 | **4.0%** | −0.82 | **collapses** |
| V5 +EngineA | 11920 | 27.9% | +2795 | |
| **V6 full system** | 3421 | **1.7%** | −0.62 | ← **worse than random** |

**Q2 answer (robust to the Sortino caveat — it's a win-rate/total comparison): the complexity is not earning its keep — it is actively harmful.**
- The full live system (V6) selects **worse than random** (1.7% vs 25% win) — `_auto_trade_allowed` is anti-correlated with 1h returns (the maturity bias: it admits mature coins that mean-revert down).
- A **2-rule baseline (intelligence + rug veto = V2)** is the best.
- M1/M2/M4/M5 add nothing (V3−V2 = noise); the **grad/confluence floor destroys** performance (V4); V6−V1 Sortino delta CI is firmly negative.

This corroborates every prior finding (confluence doesn't separate winners; maturity bias). **Caveat:** Sortino is cap-inflated (unreliable in a tail-heavy distribution) — win-rate/total/deltas are the trustworthy signals; and this is the *partial* label window. The conclusive kill-gate verdict still needs the full ≥14-day window spanning a detected meta-shift (T1.3) with PumpSwap ingestion on. But the directional Q2 signal — **strip the system toward intelligence-score + rug-veto; the engines/confluence/fusion above that are cost without benefit, and the maturity floor is harmful** — is strong and consistent.

**Hardening check (2026-06-22) — Sortino caveat discharged.** Re-ran the ladder using only **cap-independent** metrics (win-rate = sign of return; median) across **three horizons** (ret_1h, ret_6h, max_gain peak-capture) — none depend on the +100× cap that inflated Sortino. The ordering is identical on all three: V6 < V2 in **3/3** metrics, and V6 < V0-random in **3/3** metrics (V6 win% = 1.7 / 1.1 / 4.4 vs V0 25.2 / 24.1 / 41.1 vs V2 43.6 / 42.2 / 51.7). The "complexity hurts selection" conclusion is therefore **not a cap artifact** — it is robust to horizon and to the choice of central-tendency statistic. The two villains are now pinpointed: the **graduation/maturity floor** (V3→V4 collapses 43.9%→4.0%) and the **full-fusion `_auto_trade_allowed` decision** (V5→V6 collapses 27.9%→1.7%); the one hero is the **rug veto** (V1→V2, +11.6pp, the largest gain in the ladder). M2/M4/M5 remain noise (V2≈V3). Still partial-window; the *conclusive* kill-gate verdict still needs the full meta-shift window — but the *direction* is now as trustworthy as this dataset allows.

### IV.9 Acting on the ablation — V2 live entry mode (2026-06-22)

The ablation said the full stack selects worse than random and a 2-rule baseline (intelligence + rug-veto) is best; the hardening check confirmed it across horizons. So the live (paper) entry was switched to that rule, env-gated and reversible:

- **`ENTRY_MODE` env** (`lib/env.ts`, helper `isV2SimpleEntry()`), **default `v2_simple`** — set `ENTRY_MODE=full` to revert to the legacy stack.
- **Entry gate** (`lib/trade/entry-filter.ts`, `qualifyV2Entry`): enter iff `_intelligence ≥ 0.5 AND M3_RUG < 0.7`. The decision **delegates to the pure, tested `variantEnters("V2", …)`** so live is identical-by-construction to the ablated V2. Bypasses confluence / three-gate / graduation floor.
- **Queue** (`lib/db/repos/paper-trades.ts`): in v2 mode the pending queue selects on the raw `_intelligence`/`M3_RUG` scores instead of the `_auto_trade_allowed` (V6) gate, independent of `AUTO_DEMO_RELAX`.
- **Auto-trader** (`lib/workers/auto-trader.ts`): in v2 mode the soft selection gates (max-entry-age, order-flow veto, activity floor, mcap ceiling) are bypassed. **Hard safety vetoes are kept**: 'rugged' label and bundle/mechanical.

**Verification (offline, against 89,326 historical buy decisions):** the V2 selector admits 43,849 (49%) vs the V6 selector's 87,042 (97%); it drops 43,193 low-intelligence/high-rug decisions and rescues 0 (the relax-polluted V6 already admitted nearly everything, so V2's value here is purely subtractive — cutting the junk). typecheck + 221 tests + lint all green. Live smoke test (restart worker with `ENTRY_MODE=v2_simple`, watch entries open on the V2 population) is the operator's step.

This is still the *partial*-window read; the conclusive kill-gate verdict needs the full ≥14-day meta-shift window. V2-as-default is the harm-reducing interim while that window accrues.

### Cumulative v2-plan state (2026-06-21, final for this session)
Sprint 1a ✅ · 1b ✅ · 2 (T1.1) ✅ · 3 (T1.2) ✅ · 3.5 (T1.3) ✅ · 4 (T2.1–T2.3) ✅ · 5 (T3.3) ✅ · **6–7 (T4 ablation harness + first result) ✅**. The entire measurement backbone AND the decisive experiment are built. The ablation has already produced a directional answer (complexity hurts; simplify to intelligence+rug). Remaining: run the ablation on the full meta-shift window for the conclusive verdict; deferred follow-ups T1.2g (PumpSwap gap recovery), T2.4 (candle ordering); and the defensive rug model (T5.1) which has standalone value.

---

*End of handoff. Part I is the as-built reference; Part II is the forward plan; Part III tracks shipped changes since the doc was first written; Part IV tracks v2-plan execution results. If you change behavior, update the cited section so this file stays the single source of truth.*
