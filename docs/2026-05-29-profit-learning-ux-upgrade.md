# Profit, Learning Loop & UX Upgrade Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Sol Pump Radar from a “runs but breaks even” demo auto-trader into a system that learns from closed trades, opens better entries, exits smoothly, and presents a consistent, understandable UI.

**Architecture:** Fix the **closed learning loop** first (outcomes → tuner → intelligence + auto-trader), then **coverage** (market mints → scoring), then **execution reliability** (queue, price, exits), then a **UX consistency layer** (one vocabulary, one skip glossary, one chart story).

**Tech Stack:** Next.js 15, Postgres/Drizzle, worker orchestrator (`apps/worker`), intelligence-commit, learner/tuner, paper engine (`@spr/trading`).

**Why zero profit today (root causes):**

1. **Learning does not change signals** — `learner.ts` writes `tuner_changes` and `learned_rules`, but `intelligence-commit` uses hardcoded gates in `auto-gate-core.ts`. Only gate *weights* reach `qualifyEntry()`.
2. **Demo relax opens weaker trades** — `AUTO_DEMO_RELAX=on` queues `auto_trade_blocked` buys and uses `qualifyDemoAutoEntry()` with low confluence floors; intelligence already said “no.”
3. **Coverage gap** — Dex/market coins often never enter `computeActiveFeatures()` → no BUY signals → empty or stale queue.
4. **TP/SL + fees on bonding curve** — squared price move + ~2% round-trip friction means many small wins become net zero or negative.
5. **`AUTO_TUNE=off` and `SHADOW_LEARNER=off`** — almost no adaptive behavior unless manually enabled.
6. **UX noise** — skip reasons shown raw; demo/paper/live used interchangeably; chart copy contradicts behavior.

---

## Phase 0 — Baseline & diagnostics (1 session)

**Outcome:** Know exactly why *your* sessions show 0 SOL before changing logic.

### Task 0.1: Session profit autopsy script

**Files:**
- Create: `scripts/session-profit-report.ts`
- Read: `lib/db/repos/outcomes.ts`, `lib/db/repos/auto-sessions.ts`, `lib/db/repos/performance.ts`

- [ ] **Step 1:** Add CLI script that prints for last 7 days:
  - Closed auto trades count, win rate, avg PnL, by exit reason (tp/sl/timeout)
  - Open positions still holding (unrealized not in `realizedPnlSol`)
  - Top 10 skip reasons from `auto_sessions.stats`
  - Count of `demo_relax_queued` vs strict `_auto_trade_allowed` entries
- [ ] **Step 2:** Add to `package.json`: `"session:report": "tsx scripts/session-profit-report.ts"`
- [ ] **Step 3:** Run and save output as baseline before Phase 1

**Run:** `pnpm session:report`  
**Expected:** Actionable counts — if `closed=0`, problem is entries; if `closed>0` and `sum≈0`, problem is exits/fees/filter quality.

### Task 0.2: Enable learning data collection (env only)

**Files:**
- Modify: `.env.local` (user machine, not committed)

- [ ] Set `AUTO_TUNE=on` (gate-weight tuning applies after 15+ samples)
- [ ] Set `SHADOW_LEARNER=on` (optional parallel strict paper trades for comparison)
- [ ] Keep `AUTO_DEMO_RELAX=on` until Phase 2 tightens demo entry — document in report

---

## Phase 1 — Close the learning loop (highest impact)

**Outcome:** Closed trade outcomes actually change what gets bought tomorrow.

### Task 1.1: Wire tuner thresholds into intelligence commit

**Files:**
- Modify: `lib/intelligence/auto-gate-core.ts`
- Modify: `lib/intelligence/commit.ts`
- Modify: `lib/db/repos/tuner.ts` (export typed reader if needed)
- Test: `lib/intelligence/auto-gate.test.ts` (extend)

- [ ] **Step 1:** Add `readEffectiveAutoGateConfig()` that merges:
  - Hardcoded defaults from `auto-gate-core.ts`
  - Active overrides from `readActiveOverrides()` (grad/rug/confluence keys already stored by learner)
  - Clamp to `MAX_DEVIATION_FROM_PRESET` (reuse learner constant or share in `lib/tuner/limits.ts`)
- [ ] **Step 2:** Use merged config inside `computeAutoTradeAllowedCore()` instead of literals only
- [ ] **Step 3:** Pass `auto_trade_allowed` rationale into `moduleScores._gate_config_hash` for traceability
- [ ] **Step 4:** Unit test — override `gradBuyStrong` 0.55→0.48 allows borderline mint when samples justified

### Task 1.2: Wire learned avoid rules into commit path

**Files:**
- Modify: `lib/intelligence/commit.ts`
- Modify: `lib/db/repos/loss-learning.ts`
- Modify: `lib/db/repos/auto-sessions.ts` (default `useLearnedAvoids: true` for paper)

- [ ] **Step 1:** Before `planIntelligenceCommit`, call `fetchActiveAvoidRules()` 
- [ ] **Step 2:** If mint matches rule (module bucket / gate pattern), force `signal=AVOID` or downgrade confidence
- [ ] **Step 3:** Log `vetoes: ['learned:rule_id']` on decision payload
- [ ] **Step 4:** Enable `useLearnedAvoids: true` in `DEFAULT_PARAMS` for paper sessions

### Task 1.3: Outcome-driven session feedback API

**Files:**
- Create: `app/api/auto/session-insights/route.ts`
- Modify: `components/AutoTradeHero.tsx`

- [ ] **Step 1:** API returns last 50 closed auto trades: entry confluence, `_engine_a`, exit reason, PnL, whether `demo_relax_queued`
- [ ] **Step 2:** Hero shows one line: “Last 7d: X trades · Y% win · strict entries +Z% vs relaxed”
- [ ] **Step 3:** Link to `/analytics#learning`

### Task 1.4: Shadow vs auto parity panel (make learning visible)

**Files:**
- Modify: `components/ShadowParityPanel.tsx`
- Modify: `lib/db/repos/performance.ts`

- [ ] **Step 1:** Compare `fetchPerformanceBreakdown()` auto vs shadow (7d)
- [ ] **Step 2:** Show recommendation: “Consider turning off demo relax” if shadow beats auto by >5% win rate with ≥20 samples

---

## Phase 2 — Profitability engine (entries, coverage, exits)

**Outcome:** Auto-trader trades the same universe you browse, with exits tuned for pump.fun math.

### Task 2.1: Unified discovery → scoring pipeline

**Files:**
- Create: `lib/market/universe-bridge.ts`
- Modify: `lib/workers/trend-scanner.ts` or new tick in `lib/workers/analytics.ts`
- Modify: `lib/db/repos/features.ts` (`computeActiveFeatures` mint source)

- [ ] **Step 1:** Every 30s, upsert mints from `fetchDiscoverySlice().allMints` into `trend_candidates` (if not rugged, not stale)
- [ ] **Step 2:** Ensure `loadCommitInputBundle()` includes bridged mints even without local WSS events yet
- [ ] **Step 3:** Log bridge stats: `{ bridged, scored, committed }` once per minute

### Task 2.2: Tiered demo entry (strict first, relax fallback)

**Files:**
- Modify: `lib/workers/auto-trader.ts`
- Modify: `lib/trade/entry-filter.ts`

- [ ] **Step 1:** Split pending queue pass:
  1. Try strict `qualifyEntry(ctx, { demoRelaxed: false })` for rows with `_auto_trade_allowed >= 1`
  2. Only if capacity remains AND `AUTO_DEMO_RELAX=on`, try `demoRelaxed: true` for `demo_relax_queued`
- [ ] **Step 2:** Tag `entry_features.entry_tier: 'strict' | 'relaxed'` on `paperOpen`
- [ ] **Step 3:** Learner attributes PnL by tier — auto-disable relax if relaxed underperforms after 30 trades

### Task 2.3: Exit strategy tuned for curve + fees

**Files:**
- Modify: `lib/db/repos/auto-sessions.ts` (`DEFAULT_PARAMS`)
- Modify: `app/api/auto/quick-start/route.ts` presets
- Modify: `lib/workers/auto-trader.ts` (`handleExits`)

- [ ] **Step 1:** New preset **“profit_seek”**: TP 35%, SL 12%, TP1 18% @ 50%, max hold 35m, size 0.05 SOL, maxConcurrent 2
- [ ] **Step 2:** Add **trailing stop** optional flag: after +15%, trail 8% from peak (paper only first)
- [ ] **Step 3:** Document in UI tooltip: “Bonding curve PnL is non-linear; wider TP helps overcome fees”

### Task 2.4: Miss report drives filter changes

**Files:**
- Modify: `components/WhyMissedPanel.tsx`
- Modify: `lib/workers/missed-winner-scan.ts`
- Create: `lib/intelligence/miss-to-action.ts`

- [ ] **Step 1:** Daily job: Dex top 24h gainers vs our stage pipeline
- [ ] **Step 2:** Surface top miss reason bucket on mission + suggested env tweak (e.g. `INTELLIGENCE_MAX_LAUNCH_HOT_PER_TICK`)
- [ ] **Step 3:** Feed repeated miss types into `mineLossPatterns()` as features

---

## Phase 3 — Execution smoothness

**Outcome:** Fewer “skipped forever” mints, predictable open/close, clear error states.

### Task 3.1: Price resolution hardening

**Files:**
- Modify: `lib/workers/auto-trader.ts`
- Modify: `lib/pump/resolve-price.ts`
- Modify: `lib/intelligence/commit.ts` (`_v_sol` stamp)

- [ ] **Step 1:** Retry vSol resolve 3× with 500ms backoff before marking `auto:no_v_sol`
- [ ] **Step 2:** Extend pending window to 180s for launch mints (`ageSeconds < 600`)
- [ ] **Step 3:** Metric: `auto_trader_price_miss_rate` in diagnostics

### Task 3.2: Queue fairness + dedupe

**Files:**
- Modify: `lib/workers/auto-trader.ts` (`balancePendingQueue`)
- Modify: `lib/db/repos/paper-trades.ts`

- [ ] **Step 1:** Dedupe pending by mint (keep newest decision id)
- [ ] **Step 2:** Cap re-evaluations per mint to 1 open attempt per 60s (transient skip map)
- [ ] **Step 3:** On successful open, mark sibling pending rows `executed='skipped'` reason `auto:opened_sibling`

### Task 3.3: Exit execution reliability

**Files:**
- Modify: `lib/paper/engine.ts`
- Modify: `lib/workers/auto-trader.ts`

- [ ] **Step 1:** Ensure `CLOSING` state recovers after 30s stuck (already partially in PROJECT_STATUS — verify + add test)
- [ ] **Step 2:** Batch exit tick: process oldest positions first (timeout risk)
- [ ] **Step 3:** Notify on failed close with actionable reason

### Task 3.4: Live path polish (optional, if user enables live)

**Files:**
- Modify: `lib/executor/live.ts`

- [ ] **Step 1:** Pre-flight balance + route quote before `openLivePosition`
- [ ] **Step 2:** Surface `LIVE_DRY_RUN` clearly in execution log row

---

## Phase 4 — Frontend consistency & clarity

**Outcome:** One vocabulary, one skip glossary, charts that match copy, mission ↔ trade aligned.

### Task 4.1: Mode glossary component

**Files:**
- Create: `components/ModeGlossary.tsx`
- Modify: `components/layout/ModeBanner.tsx`, `components/trade/AutoTradeHero.tsx`

- [ ] **Step 1:** Single tooltip/block explaining:
  - **Demo** = virtual wallet, paper ledger, safe to experiment
  - **Real** = your wallet connected; live trades only when runtime allows
  - Backend `paper`/`live` tags map 1:1 in UI
- [ ] **Step 2:** Replace scattered “paper” in trade UI with “demo” where user-facing

### Task 4.2: Unified skip reason labels

**Files:**
- Modify: `lib/ui/plain-labels.ts`
- Modify: `components/AutoTradeLog.tsx`, `components/AutoTradeHero.tsx`, `components/SignalDashboard.tsx`

- [ ] **Step 1:** Export `formatAutoSkip(reason: string): string` used everywhere
- [ ] **Step 2:** Diagnostics bar uses plain labels, not raw `coin gate failed: grad=0.06`
- [ ] **Step 3:** Add “What this means” expander with fix hint (e.g. “Wait for 60s sniper window” → “Token too new; will retry”)

### Task 4.3: Chart & copy audit

**Files:**
- Modify: `components/AutoTradePositions.tsx` (header subtitle)
- Modify: `components/TokenDexView.tsx`, `components/ExternalDexEmbed.tsx`

- [ ] **Step 1:** Trade panel header: “Your entry on Radar chart (DexScreener optional below)”
- [ ] **Step 2:** Token page: remove “Quick Trade below” unless quick trade added
- [ ] **Step 3:** Auto-scroll chart to buy candle on expand (`TokenChart` ref + `scrollIntoView` on marker idx)

### Task 4.4: Nav & layout unification

**Files:**
- Modify: `components/layout/PortalLayout.tsx`
- Modify: `components/mission/MissionControlShell.tsx`

- [ ] **Step 1:** Align labels: Trade = “Trade”, Market = “Market”, Signals = “Signals” (same on mission rail)
- [ ] **Step 2:** Mission rail highlights current route when not on `/mission`
- [ ] **Step 3:** Add compact Demo/Real pill on mission header linking to `/trade`

### Task 4.5: Consolidate holdings story

**Files:**
- Modify: `app/holdings/page.tsx`, `app/paper/page.tsx`
- Modify: `components/layout/PortalLayout.tsx` nav

- [ ] **Step 1:** `/holdings` = canonical “all positions”; `/paper` redirects or shows “Moved to Holdings”
- [ ] **Step 2:** Trade auto panel subtitle: “Session positions only — see Holdings for full wallet”

### Task 4.6: Profit dashboard strip on Trade page

**Files:**
- Create: `components/AutoTradeInsights.tsx`
- Modify: `app/trade/page.tsx`

- [ ] **Step 1:** Show session + 7d: trades, win%, realized PnL, avg hold, strict vs relaxed split
- [ ] **Step 2:** Empty state: “No closed trades yet — check skip log below” with link to diagnostics

---

## Phase 5 — Verification & success metrics

### Task 5.1: Automated checks

- [ ] `pnpm typecheck && pnpm test && pnpm verify:review`
- [ ] `pnpm session:report` — closed trades > 0 over 24h test run
- [ ] `pnpm demo:freq-check` — pending queue converts to opens at healthy rate

### Task 5.2: Success criteria (2-week paper run)

| Metric | Target |
|--------|--------|
| Closed trades / session | ≥ 5/day (hybrid mode, worker on) |
| Skip log top reason | Not same reason >80% of ticks |
| Strict tier win rate | ≥ relaxed tier OR relax auto-disabled |
| Realized PnL | Positive over 7d **or** learner proposes tightening with evidence |
| User comprehension | Single mode glossary; skip reasons plain-language |

---

## Implementation order (recommended)

```
Phase 0 (baseline) → Phase 1.1–1.2 (learning loop) → Phase 2.1–2.2 (coverage + tiered entry)
→ Phase 3.1–3.2 (execution) → Phase 4.1–4.3 (UX clarity) → Phase 2.3–2.4 (exits + miss report)
→ Phase 4.4–4.6 (polish) → Phase 5 (verify)
```

**Do not start with UI-only changes** — zero profit is primarily a **learning loop + entry quality** problem.

---

## Env cheat sheet (after plan)

| Variable | Recommended for profit learning |
|----------|----------------------------------|
| `AUTO_TUNE` | `on` |
| `SHADOW_LEARNER` | `on` (compare strict vs demo) |
| `AUTO_DEMO_RELAX` | `on` until Task 2.2 proves strict tier wins |
| `SIGNAL_MODE` | `hybrid` |
| `AUTO_CONTINUATION` | `on` (Engine B auto candidates) |
| `WORKERS` | `on` + `pnpm worker` running |

---

## Execution handoff

**Plan saved to:** `docs/superpowers/plans/2026-05-29-profit-learning-ux-upgrade.md`

**Two execution options:**

1. **Subagent-driven (recommended)** — one task per agent, review between tasks  
2. **Inline execution** — implement phases in this chat with checkpoints  

**Suggested first implementation batch:** Phase 0 + Task 1.1 + Task 2.2 (biggest profit levers, ~1 day).
