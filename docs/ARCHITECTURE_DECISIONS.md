# Architecture decisions — sol-pump-radar

This document records **recommended answers** to the dual-engine architecture questionnaire, grounded in:

- The current **sol-pump-radar** codebase (as implemented)
- Your stated goals: catch **Dex-style 24h runners**, prove **demo/paper** first, personal localhost tool
- Observed failure mode: **missing winners** (Dex shows momentum; local pipeline sees dead/no-flow)

Use this as the contract for the next implementation phases. Override any line that does not match your intent.

---

## Project snapshot (current implementation)

| Item | Detail |
|------|--------|
| **Name** | sol-pump-radar v0.0.1 |
| **Purpose** | Localhost-only pump.fun analytics + paper-first (optional live) trading dashboard |
| **License** | MIT — personal research, not financial advice |
| **Repo layout** | Workspace: Next app (root) + `apps/worker` + `packages/{db,core}` |
| **UI** | Next.js 15 (App Router), React 19, Tailwind — `http://127.0.0.1:3000` |
| **API host** | Next API only — no separate host |
| **Runtime workers** | `apps/worker` (`pnpm worker`) — sole automation runtime |
| **Database** | **Docker Postgres 16** + Drizzle ORM, `DATABASE_URL` |
| **Migrations** | `drizzle/0000` … `0007_trend_candidates.sql` |
| **Queue / bus** | None — in-process intervals + global analytics snapshot |
| **Primary ingest** | WSS `logsSubscribe` on **pump bonding-curve program only** |
| **Secondary ingest** | DexScreener API, Pump.fun REST, optional GMGN; trend-scanner snapshots |
| **Scoring modules** | M1 graduation, M2 insider, M3 rug, M4 creator, M5 wash + three-gate + confluence |
| **Decision actions** | `BUY_STRONG`, `BUY_MODERATE`, `WATCH`, `AVOID` (no separate continuation actions yet) |
| **Signal modes** | `SIGNAL_MODE=profit` (default, 240m window) vs `launch` (15m sniper) |
| **Auto-trade** | `auto-trader` 3s tick, session params in `auto_sessions`, demo relax path |
| **Paper / live** | `TRADER_MODE=paper` default; live gated by `LIVE_EXECUTION`, wallet vault |
| **RPC** | Comma-separated public mainnet URLs; optional `HELIUS_API_KEY`, `SHYFT_API_KEY` |
| **Key workers** | ingestor, analytics, decision, trader, auto-trader, bot-detector, clusterer, rug-labeler, trend-scanner, shadow-learner, learner, notifier |

### Worker pipeline (today)

```
ingestor (curve WSS)
  → events + tokens
analytics (computeActiveFeatures → score M1–M5)
  → global snapshot
decision (thresholds, vetoes, pump_trap, continuation helper)
  → decision_log (executed=pending|…)
trader / auto-trader (qualifyEntry, paper/live open)
  → paper_trades / live_trades
```

### Market discovery (UI vs scoring)

- **UI** (`lib/market/discovery.ts`): Pump trenches + Dex token-boosts (~20) + optional GMGN.
- **Scoring universe** (`computeActiveFeatures`): mints with **local events (240m)** OR **trend_candidates (30m)**.
- **Gap**: Dex trending coins can appear in UI without ever entering analytics/decision.

### Auto-session defaults (`DEFAULT_PARAMS`)

- 0.03 SOL/trade, TP 28%, SL 15%, max 3 concurrent, daily loss cap 0.3 SOL
- `signalStrictness: strong_and_moderate`, `useLearnedAvoids: false` (paper)

---

## Critical architecture answers

### 1. Primary objective — **C (Hybrid)**

| Engine | Role |
|--------|------|
| **A — Launch Intelligence** | Early bonding-curve sniper; bundle/rug/insider; current core |
| **B — Continuation Momentum** | Post-migration Dex momentum; new data plane required |

**Why C:** Your benchmark (Dex 24h leaders) is Engine B; your implemented stack is Engine A. One combined model will keep “missing winners” while blocking “late chase” correctly for A.

**Not chosen:** A-only → never aligns with Dex leaderboard evaluation. B-only → throws away early-edge research already built.

---

### 2. Auto-trading philosophy — **Split (recommended)**

| Extension (from first tracked / curve baseline) | Launch auto | Continuation auto | UI |
|--------------------------------------------------|-------------|-------------------|-----|
| **&lt; ~150%** | Allowed if gates pass | Allowed if momentum + liq gates pass | BUY + auto |
| **150% – 400%** | Downgrade / WATCH | Allowed with smaller size + tighter SL | BUY_MODERATE / alert |
| **&gt; 400%** (e.g. +700%, +3000%) | **No auto** | **Alerts + watchlist only** unless you explicitly opt into “aggressive continuation auto” | `MOMENTUM_ALERT` |

**Rationale:** Names like Stake (+3000% on a pair) are economically **late** for curve-snipe logic; auto-buying them fights `pump_trap` design. You still want **visibility** (Engine B alerts).

**Tunable env (future):** `CONTINUATION_AUTO_MAX_EXTENSION=1.5`, `CONTINUATION_ALERT_MIN_H24_PCT=50`.

---

### 3. Universe scope — **B → C (phased)**

| Phase | Scope |
|-------|--------|
| **Now** | pump.fun curve + pumpswap graduates + Dex-boosted discovery (mostly `…pump` mints) |
| **Next** | **First-class migrated pools** (pumpswap primary; meteora/raydium as Dex aggregates) |
| **Later** | Broader “any Solana meme with liquidity + momentum” (full C) |

Include non-`pump` mints (e.g. `2MBq3m…`, `cig9AX…`) in **continuation registry** via Dex token lookup, not only pump API.

---

### 4. Data infrastructure budget — **Target: Mid | Today: Budget+**

| Tier | Status | Use |
|------|--------|-----|
| **Budget** | **Current** | Dex API, Pump API, curve WSS, snapshot events, 30s trend-scanner |
| **Mid** | **Recommended next** | Helius or Shyft enhanced txs / pool activity for **post-migration** swaps |
| **Pro** | **Defer** | Geyser/Yellowstone — only if sub-ms sniper competition required |

**Cost realism:** Mid tier is enough to fix “Dex winner / local dead mint” for continuation. Pro is not required for seconds-level continuation.

---

### 5. Latency target — **Dual**

| Engine | Target | Rationale |
|--------|--------|-----------|
| **Launch (A)** | **B — Sub-second** (within RPC/WSS limits) | Curve sniping benefits from fast ingest; you already use WSS logs |
| **Continuation (B)** | **A — Seconds** (5–30s poll + 10s decision tick) | Dex momentum does not need MEV latency; polling is acceptable |

**Not chosen:** C (millisecond) — disproportionate infra for personal localhost bot.

---

### 6. Strategy priority ranking (1 = most important)

Recommended order for **your stated goals** (catch big runners + explain misses + demo safety):

1. **Catching big runners** (Engine B visibility + recall)
2. **Explainability** (why missed / why vetoed)
3. **Avoiding rugs** (hard vetoes stay)
4. **Early entry** (Engine A)
5. **Accuracy** (precision on auto entries)
6. **Low drawdown**
7. **Fewer false positives** (secondary to recall for alerts)
8. **Fast execution**
9. **High trade frequency**
10. **Fully automated trading**
11. **Scalability**

**Implied change:** Engine B optimizes **recall + trace**; Engine A auto optimizes **precision + early**.

---

### 7. Risk appetite — **Balanced (with split by engine)**

| Engine | Profile |
|--------|---------|
| **Launch auto** | **Balanced → Conservative** until paper stats prove edge |
| **Continuation alerts** | **Balanced → Aggressive** (show more names, accept noise) |
| **Continuation auto** | **Balanced** only after Phase 2 backtest |

Matches `RISK_PRESET` env (conservative | balanced | aggressive) per engine in future.

---

### 8. Current infrastructure (exact)

| Category | Answer |
|----------|--------|
| **Backend** | Node.js 20 + Next.js 15 (UI/API) + `apps/worker` (automation) |
| **Language for trading logic** | TypeScript (`lib/workers`, `lib/modules`, `lib/trade`) |
| **DB** | **Docker Postgres 16** + Drizzle |
| **ORM** | Drizzle |
| **Queue / events** | **None** — `setInterval` workers, in-memory `getAnalyticsSnapshot()` |
| **Deployment** | **Local machine** (Windows dev primary); no Docker/K8s in repo |
| **RPC** | Public Solana RPC default; optional **Helius**, **Shyft** API keys in `.env` |
| **Execution** | Paper executor; live via Jupiter + PumpPortal URLs; encrypted vault `./data/vault.bin` |
| **Notifications** | Discord webhook, Telegram optional |

---

### 9. Current system bottleneck — **A + E (primary)**

| Code | Issue |
|----|--------|
| **A — Missing winners** | Structural: post-migration volume not in `events`; Dex universe ⊄ scoring universe; `pump_trap` vetoes |
| **E — System instability** | Operational: `WORKERS=off`, port 3000 EADDRINUSE, Next spawn failures → pipeline dead while UI looks “on” |

Secondary: **C** delayed detection for migrated names; **D** noisy WATCH vs no BUY confusion.

**Not primary today:** B too many bad trades (you reported **zero** opens); G slippage; H DB perf.

---

### 10. Desired final product — **A, path to B**

| Phase | Product |
|-------|---------|
| **Now** | **A — Personal trading bot** (localhost, paper → gated live) |
| **Next** | **B — Signal platform** (alerts, continuation dashboard, miss reports) inside same app |
| **Not in scope** | C SaaS multi-tenant, D hedge-fund infra, E pure research without execution |

---

### 11. Explainability — **Yes (required)**

| Today | Gap |
|-------|-----|
| `decision_log.reason_human`, `vetoes`, `executor_reason` | Good for executed/skipped |
| `recentFilterSkips` on auto session | Transient filter reasons |
| `/api/auto/diagnostics` | Pipeline health |

**Needed (decision-trace subsystem):**

- Stage: `not_in_active` | `scored` | `veto_*` | `emitted` | `auto_rejected`
- Feature snapshot at decision time (pumpMultiple, buys5m, liq from Dex, engine=A|B)
- Per-mint **miss report** vs Dex top-N daily

---

### 12. Historical learning — **Hybrid**

| Mode | Implementation |
|------|----------------|
| **Default** | Rule-based, deterministic thresholds (`RISK_PRESET`, `SIGNAL_MODE`) |
| **Optional** | `AUTO_TUNE=on` + learner worker proposes threshold changes |
| **Future** | Archetype classifier (launch vs continuation vs exhaustion) from labeled outcomes |

**Not:** full ML retrain in v1 — insufficient labeled data and explainability cost.

---

### 13. Trade execution scope — **Fully auto (paper); gated live**

| Mode | Today |
|------|--------|
| **Signals** | Always (decision worker) |
| **Semi-auto** | Manual start/stop auto session |
| **Full auto** | `auto-trader` when session active |

**Paper / demo params:** see `DEFAULT_PARAMS` above.

**Live:** `LIVE_EXECUTION=off` default; `LIVE_DRY_RUN=on`; caps `LIVE_MAX_PER_TRADE_SOL`, `LIVE_MAX_DAILY_SOL`.

**Future split:** Launch auto session vs Continuation auto session with different TP/SL (continuation: wider SL, shorter hold or trailing).

---

### 14. Success definition — **Split by engine**

| Engine | Success metric |
|--------|----------------|
| **Launch auto (A)** | **A — Precision**: 2 of top 10 **early** curve calls with controlled drawdown |
| **Continuation (B)** | **B — Recall**: 7 of top 10 Dex 24h names **flagged** (alert or WATCH) even if auto skips |

You cannot use one metric for both; Dex leaderboard evaluation is recall-heavy.

---

### 15. Post-migration support — **First-class citizens**

Migrated coins must:

- Enter **mint registry** with primary pool (pumpswap/meteora) from Dex
- Receive **Dex-sourced features** (h24 vol, liq, txns, price change) even when `events` is sparse
- Be scored by **Engine B** independently of curve `pumpMultiple` veto (or use Dex-relative extension)

**Not sufficient:** trend-scanner snapshots only when local buy/sell absent (current partial fix).

---

## Target dual-engine architecture

### Engine A — Launch Intelligence (existing, refine)

- **Inputs:** curve WSS, bot flags, wallet profiles, rug labels
- **Outputs:** `BUY_STRONG`, `BUY_MODERATE`, `WATCH`, `AVOID`, `GRADUATION_READY` (future)
- **Auto:** current `auto-trader` + `qualifyEntry` / demo relax
- **Anti-goals:** chasing +500% Dex parabolas

### Engine B — Continuation Momentum (new)

- **Inputs:** Dex trending/top gainers, pool liquidity, cross-DEX volume, holder dispersion (Mid tier when available)
- **Outputs:** `CONTINUATION_BUY`, `MOMENTUM_ACCELERATION`, `EXHAUSTION_WARNING`, `DEX_TREND_ALERT`
- **Auto:** optional Phase 3; alerts Phase 1
- **Anti-goals:** illiquid rugs, exhaustion wicks

### Shared systems

| System | Purpose |
|--------|---------|
| Unified mint registry | mint, pools[], source, first_seen, migration_at |
| Feature store | `token_features` + `dex_features` columns or table |
| Decision trace | `decision_trace` or JSON on `decision_log` |
| Archetype classifier | launch / continuation / dead-cat / exhaustion |
| Replay / post-mortem | Dex top-N vs our emissions daily |
| Event bus (optional later) | Redis only if multi-process |

---

## Phased implementation roadmap

| Phase | Deliverable | Depends on |
|-------|-------------|------------|
| **0 — Ops** | `WORKERS=on`, port 3000 reuse, diagnostics green | — |
| **1 — Visibility** | Dex 24h universe worker; Engine B **alerts only**; miss report API | Budget |
| **2 — Features** | `dex_features` table; continuation scoring without curve flow | Budget |
| **3 — Auto** | Continuation auto profile (capped extension); split UI panels | Mid optional |
| **4 — Trace** | Full decision-trace + daily “why missed” for user mint list | — |
| **5 — Mid ingest** | Helius/Shyft swaps on pumpswap for graduated mints | API keys |

---

## Instrumentation: “why winners are missed”

For each mint (e.g. your eight Dex leaders), log highest stage reached:

```
discovered_ui → in_trend_candidates → in_active_features → analytics_scored
→ decision_emitted → pending → auto_opened | auto_filter (reason) | never_seen
```

Daily job: `dex_top_50_24h` LEFT JOIN stages → report `% missed at coverage vs veto vs auto`.

---

## Reference mints (evaluation set)

Use for replay and miss reports:

1. `5gdkymiHDBetTnCBjr1YAeqMCeGJKVFRkumrAAgmpump` — GENWEALTH  
2. `8Zrbh9DJFgY5H6jqZb3CWeMF6wLGMHiDKvkK4qSTpump` — CAP  
3. `5s7tf6ih2CEZf7ZPNkJAtcknAq9DL5GsWHMMT3Jdpump` — Stake  
4. `2MBq3mrKSKf6NnG5x29rBK4B9f7CWR4N1EQJ18NsViRL` — TRALALERO (non-pump suffix)  
5. `Ac8EScJ4ufRo8PiFkun7diUrcCCktg4JvArb3mPmpump` — PP420  
6. `Br1JxELQYP34YdRW4gbEPLasHEtyz8eCmT2FvmnYpump` — PARALOOM  
7. `Cjo46uRW2yeF2uXLn2phrVZZyZ1sfnrMNutfrhZopump` — ETB  
8. `cig9AXeEzQMUts9WXzmb8S5DapSVJ2b8JnrRmnWRdYz` — CIG (non-pump suffix)  

---

## Quick answer card (copy-paste)

```
1:  C
2:  Split — auto below ~150–400% extension; alerts above; no auto on +3000% parabolas unless opt-in
3:  B → C (pump-first, Dex-registered migrated, then broad momentum)
4:  Target Mid; today Budget+
5:  Launch sub-second; Continuation seconds
6:  Runners > Explainability > Rugs > Early entry > Accuracy > Drawdown > FP > Speed > Freq > Full auto > Scale
7:  Balanced (Conservative launch auto, Aggressive continuation alerts)
8:  Node/Next + apps/worker, Docker Postgres/Drizzle, local deploy, public RPC + optional Helius/Shyft
9:  A missing winners + E instability
10: A personal bot → B signals
11: Yes full trace
12: Rules + optional AUTO_TUNE; archetypes later
13: Full auto paper; gated live; see DEFAULT_PARAMS
14: A precision for launch auto; B recall for continuation
15: First-class migrated
```

---

## Related docs

- [ARCHITECTURE.md](./ARCHITECTURE.md) — module layout
- [PROJECT_STATUS.md](./PROJECT_STATUS.md) — runtime contract
- `.env.example` — `DATABASE_URL`, `SIGNAL_MODE`, RPC keys

If any answer above is wrong for your intent, change the line in this file first — implementation should follow this contract.
