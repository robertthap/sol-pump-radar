import "server-only";
import { sql } from "drizzle-orm";
import { logger } from "@/lib/log";
import { env, rpcHttpUrls, activeMintWindowMinutes, autoDemoRelaxEnabled, isLiveAllowed, allowsLaunchTier, isV2SimpleEntry } from "@/lib/env";
import { assertLiveExecutionAllowed } from "@/lib/runtime/live-guards";
import { readState } from "@/lib/circuit-breaker/state";
import { haltedNow as haltGuard, runHaltShutdown } from "@/lib/workers/halt-guard";
import { getDb } from "@/lib/db/client";
import {
  fetchPendingBuyDecisions,
  fetchTradableAutoFallback,
  markDecisionsSkipped,
  fetchOpenOwnershipCounts,
  type PendingBuyDecisionDto,
} from "@/lib/db/repos/paper-trades";
import {
  closeLivePosition,
  fetchOpenLivePositions,
  openLivePosition,
} from "@/lib/db/repos/live-trades";
import {
  getActiveSession,
  markSessionError,
  stopSession,
  updateStats,
  type AutoSessionDto,
} from "@/lib/db/repos/auto-sessions";
import { recordOutcome } from "@/lib/db/repos/outcomes";
import { insertPositionMarks, type PositionMarkInsert } from "@/lib/db/repos/position-marks";
import { ageSeconds, shouldMark } from "@/lib/paper/position-marks";
import { fetchMintLaunchActivity } from "@/lib/db/repos/events";
import { recordPostExitSnapshot } from "@/lib/db/repos/measurement";
import { evaluateGenesisSnipe } from "@/lib/intelligence/genesis-snipe";
import { fetchGenesisSnipeCandidates } from "@/lib/db/repos/genesis-signals";
import { markPnl } from "@/lib/pricing/seam";
import { riskBudgetFor } from "@/lib/risk/presets";
import { peekKeypair } from "@/lib/wallet/session";
import { fetchMintFlags } from "@/lib/db/repos/bots";
import { fetchRugLabels } from "@/lib/db/repos/rug-labels";
import { imitationPenaltyPct } from "@/lib/intel/imitation";
import { executeLiveBuy, executeLiveSell } from "@/lib/executor/live";
import { notify } from "@/lib/notify";
import { analyzeMintInsiders } from "@/lib/intel/insider-tracker";
import { qualifyEntry } from "@/lib/trade/entry-filter";
import { relaxedTierEnabled } from "@/lib/trade/tier-control";
import { coalesceFlowAgeSeconds, resolveTimingAgeSeconds } from "@/lib/trade/timing-age";
import { fetchDemoAccount, getUiTradingMode } from "@/lib/db/repos/trading-mode";
import { resolveEntryVSol } from "@/lib/pump/resolve-price";
import { fetchPumpFunCoin } from "@/lib/pump/fun-api";
import { mcapUsdFromVSol, effectiveVSolFromMcapUsd } from "@/lib/dex/curve-mcap";
import { fetchDexMarketBatchCached } from "@/lib/dex/snapshot-cache";
import { flowThresholdsFor, passesFlowGate } from "@/lib/trade/entry-flow";
import { latestVSolBatch } from "@/lib/db/repos/events";
import { VSOL_MODULE_KEY } from "@/lib/intelligence/scored-mint-adapter";
import { paperOpen, paperClose, paperPartialClose, getPaperConfig } from "@/lib/paper/engine";
import { entryHeadroom } from "@/lib/trade/capacity";
import { decidePaperExit } from "@/lib/paper/exit-decision";
import { executePaperBuy } from "@/lib/executor/normalizer";
import {
  buildExecutionPlan,
  execMemoryFields,
  type TradeIntent,
} from "@/lib/executor/exec-normalize";
import { microSimulate } from "@/lib/executor/micro-sim";
import { regimeSizedSol } from "@/lib/risk/position-sizing";
import { evaluateKillSwitch } from "@/lib/risk/kill-switch";
import { getCurrentRegime } from "@/lib/intelligence/regime";
import { attributePnl, attributionFields } from "@/lib/intelligence/pnl-attribution";
import { touchWorker } from "@/lib/workers/heartbeat";

const log = logger("auto-trader");
const TICK_MS = 3_000;
let lastPendingFallbackAt = 0;
// Throttle the orphaned-cap warning so it doesn't flood every tick while leftover
// positions from a pre-restart session drain (they self-clear at stagnation/max-hold).
let lastOrphanWarnAt = 0;
let lastOrphanCount = -1;

async function resolvePendingBuyQueue(): Promise<PendingBuyDecisionDto[]> {
  const queueOpts = { relaxAutoGate: autoDemoRelaxEnabled() };
  let pendings = await fetchPendingBuyDecisions(120, queueOpts);
  if (pendings.length > 0) return balancePendingQueue(pendings);
  if (Date.now() - lastPendingFallbackAt < 120_000) return [];
  lastPendingFallbackAt = Date.now();

  pendings = await fetchPendingBuyDecisions(180, queueOpts);
  if (pendings.length > 0) return balancePendingQueue(pendings);

  return balancePendingQueue(await fetchTradableAutoFallback(8, queueOpts));
}

/** Interleave launch (Engine A / curve) and continuation (Engine B / DEX) candidates. */
function balancePendingQueue(items: PendingBuyDecisionDto[]): PendingBuyDecisionDto[] {
  if (items.length < 2) return items;
  const launch: PendingBuyDecisionDto[] = [];
  const cont: PendingBuyDecisionDto[] = [];
  for (const d of items) {
    const ms = d.moduleScores ?? {};
    // Authoritative launch tag from the engine (Engine A = curve launch). The old
    // `action === "BUY_MODERATE"` catch-all misclassified almost everything as
    // launch, so the interleave never separated launches from continuation.
    const isLaunch = (ms._engine_a ?? 0) >= 1 || (ms.M1_GRADUATION ?? 0.5) < 0.35;
    if (isLaunch) launch.push(d);
    else cont.push(d);
  }
  if (launch.length === 0 || cont.length === 0) return items;
  const out: PendingBuyDecisionDto[] = [];
  let i = 0;
  let j = 0;
  while (i < launch.length || j < cont.length) {
    if (i < launch.length) out.push(launch[i++]!);
    if (j < cont.length) out.push(cont[j++]!);
  }
  return out;
}

/** True when the decision passed the strict auto-gate (not merely demo-relax queued). */
function isStrictAllowed(d: PendingBuyDecisionDto): boolean {
  const ms = (d.moduleScores ?? {}) as Record<string, number>;
  return (ms._strict_allowed ?? 0) >= 1;
}

/** Stable strict-first ordering so strict entries consume capacity before relaxed. */
function strictFirst(items: PendingBuyDecisionDto[]): PendingBuyDecisionDto[] {
  return [...items].sort((a, b) => Number(isStrictAllowed(b)) - Number(isStrictAllowed(a)));
}

async function latestVSolFor(mint: string): Promise<number | null> {
  return resolveEntryVSol(mint);
}

/** Trailing consecutive-loss streak for a session's most recent paper closes. */
async function recentConsecutiveLosses(session: AutoSessionDto): Promise<number> {
  if (session.mode !== "paper") return 0;
  const res = await getDb().execute(sql`
    SELECT realized_pnl_sol::float8 AS pnl
    FROM paper_positions
    WHERE state = 'CLOSED'
      AND entry_features->>'session_id' = ${session.id}
      AND close_reason <> 'manual_verify'
    ORDER BY closed_at DESC
    LIMIT 20
  `);
  const rows = (res as unknown as { rows: Array<{ pnl: number | null }> }).rows;
  let streak = 0;
  for (const r of rows) {
    if ((r.pnl ?? 0) <= 0) streak++;
    else break;
  }
  return streak;
}

function vSolHintFromModules(moduleScores: Record<string, number>): number | null {
  const keys = [VSOL_MODULE_KEY, "_v_sol", "v_sol", "V_SOL", "current_v_sol"] as const;
  for (const k of keys) {
    const v = moduleScores[k];
    if (v != null && Number.isFinite(v) && v > 0) return v;
  }
  return null;
}

function shouldAcceptAction(action: string, strictness: AutoSessionDto["params"]["signalStrictness"]) {
  if (strictness === "strong") return action === "BUY_STRONG";
  return action === "BUY_STRONG" || action === "BUY_MODERATE";
}

export async function startAutoTrader() {
  log.info("auto-trader starting", { tickMs: TICK_MS });

  let running = false;
  // Kill-switch cooldown: pauses NEW entries after a consecutive-loss streak;
  // exits keep running and the pause auto-expires (recoverable, unlike the
  // terminal daily-loss stop).
  let entryCooldownUntil = 0;
  const ENTRY_COOLDOWN_MS = 5 * 60_000;

  // Fresh-start safety: never resume auto-trading just because a session was left
  // 'active' before this worker (re)started. Retire it so the bot stays OFF until the
  // user explicitly presses Start (this also clears the home "session running" prompt,
  // since that reflects an active session). Safe direction — and essential for live.
  try {
    const prior = await getActiveSession();
    if (prior) {
      await stopSession("worker_restart");
      log.info("retired session left active before restart — auto-trade off until Start", {
        mode: prior.mode,
      });
    }
  } catch (e) {
    log.warn("boot session-retire failed", { err: String(e) });
  }

  async function tick() {
    if (running) return;
    running = true;
    const t0 = Date.now();
    touchWorker("auto-trader");
    try {
      const session = await getActiveSession();
      if (!session) {
        // No active session means nobody is managing exits. A session that
        // stopped (loss-cap / manual / worker-restart) leaves its open positions
        // dangling forever. Sweep them closed at last mark so they can't get stuck.
        await sweepOrphanedOpenPositions();
        return;
      }

      const cb = await readState();
      if (cb.state === "HALTED") {
        // Manage exits ONE last time before retiring the session. Stopping first
        // left every open position unmanaged until the next tick's orphan sweep
        // (paper) or indefinitely (live, which the sweep does not cover).
        // Ordering lives in halt-guard.ts so it is unit-tested; behaviour is
        // unchanged (exit failure is reported and does not block retirement).
        await runHaltShutdown({
          handleExits: () => handleExits(session),
          stopSession: () => stopSession("system halted"),
          onExitError: (e) => log.warn("halt exit pass failed", { err: String(e) }),
        });
        return;
      }

      const today = await todayLossSol(session);
      if (today >= session.params.maxDailyLossSol) {
        await stopSession(`daily loss cap (${today.toFixed(3)} ≥ ${session.params.maxDailyLossSol})`);
        log.warn("auto-trader stopped: daily loss cap", { today });
        return;
      }

      const liveAvail = session.mode === "live"
        ? env().LIVE_EXECUTION === "on" && !!peekKeypair()
        : true;
      if (session.mode === "live" && !liveAvail) {
        await markSessionError(
          env().LIVE_EXECUTION !== "on" ? "LIVE_EXECUTION=off" : "wallet locked",
        );
        return;
      }

      // === Manage exits (paper + live concurrently) ===
      await handleExits(session);

      // === Kill-switch: pause entries on a consecutive-loss streak (L6.1) ===
      const consecLosses = await recentConsecutiveLosses(session);
      // Paper measurement uses a loose consecutive-loss threshold (25) so the
      // kill-switch doesn't constantly pause data collection on a losing streak —
      // the daily loss cap is the real safety here. Live keeps the strict env cap.
      const maxConsec = session.mode === "live" ? env().LIVE_MAX_CONSECUTIVE_LOSSES : 25;
      const ks = evaluateKillSwitch({
        dailyLossSol: today,
        maxDailyLossSol: session.params.maxDailyLossSol,
        consecutiveLosses: consecLosses,
        maxConsecutiveLosses: maxConsec,
        cooldownUntilMs: entryCooldownUntil || undefined,
      });

      // === Manage entries (unless the kill-switch is pausing them) ===
      let entryTick: EntryTickStats;
      if (ks.halt && (ks.scope === "consecutive" || ks.scope === "cooldown")) {
        if (ks.scope === "consecutive" && entryCooldownUntil <= Date.now()) {
          entryCooldownUntil = Date.now() + ENTRY_COOLDOWN_MS;
          log.warn("auto entries paused (kill-switch)", { reason: ks.reason, consecLosses });
        }
        entryTick = {
          pendingCount: 0,
          opened: 0,
          topSkipReasons: [`kill-switch: ${ks.reason ?? "paused"}`],
          recentFilterSkips: [],
        };
      } else {
        if (entryCooldownUntil && Date.now() >= entryCooldownUntil) {
          entryCooldownUntil = 0;
          log.info("auto entries resumed (cooldown expired)");
        }
        // Genesis-sniper path — runs BEFORE handleEntries so fresh-curve mints
        // get a shot before the DEX-flow filter chain rejects them. No-op when
        // env.GENESIS_SNIPER is "off" (default). Best-effort: a failure here
        // must never block the regular entry path.
        try { await handleGenesisEntries(session); } catch (e) {
          log.warn("genesis-entries failed", { err: String(e) });
        }
        entryTick = await handleEntries(session);
      }

      const prevSkips = session.stats.recentFilterSkips ?? [];
      const recentFilterSkips = [...entryTick.recentFilterSkips, ...prevSkips].slice(0, 40);

      await updateStats(BigInt(session.id), {
        lastTickAt: new Date().toISOString(),
        lastPendingCount: entryTick.pendingCount,
        lastOpenedCount: entryTick.opened,
        lastSkipReasons: entryTick.topSkipReasons,
        recentFilterSkips,
      });
    } catch (e) {
      log.error("auto-tick failed", { err: String(e) });
    } finally {
      touchWorker("auto-trader", { tickMs: Date.now() - t0 });
      running = false;
    }
  }

  const interval = setInterval(() => {
    tick().catch((e) => log.error("auto-tick rejected", { err: String(e) }));
  }, TICK_MS);
  setTimeout(() => tick().catch(() => undefined), 4_000);
  return () => clearInterval(interval);
}

async function todayLossSol(session: AutoSessionDto): Promise<number> {
  if (session.mode === "paper") {
    // Source of truth = paper_positions (FSM-managed). Session tag stored in
    // entry_features.session_id JSONB.
    const res = await getDb().execute(sql`
      SELECT COALESCE(SUM(realized_pnl_sol), 0)::float8 AS loss
      FROM paper_positions
      WHERE entry_features->>'session_id' = ${session.id}
        AND state = 'CLOSED'
        AND closed_at::date = now()::date
        AND realized_pnl_sol < 0
    `);
    return Math.abs(((res as unknown as { rows: Array<{ loss: number }> }).rows[0]?.loss ?? 0));
  }
  const res = await getDb().execute(sql`
    SELECT COALESCE(SUM(pnl_sol), 0)::float8 AS loss
    FROM live_trades
    WHERE session_id = ${session.id}
      AND status = 'closed'
      AND closed_at::date = now()::date
      AND pnl_sol < 0
  `);
  return Math.abs(((res as unknown as { rows: Array<{ loss: number }> }).rows[0]?.loss ?? 0));
}

/**
 * Current vSol for an OPEN position, graduation-aware. On the bonding curve we use
 * our on-chain resolver (events.v_sol_after). Once a coin graduates that value
 * freezes (we stop seeing pump.fun curve trades), so we derive an effective vSol
 * from the live DEX market cap (pump usdMarketCap) — keeping PnL + exit decisions
 * tracking the real post-graduation price instead of stalling at ~breakeven.
 */
async function resolveCurrentForExit(
  mint: string,
): Promise<{ vSol: number | null; graduated: boolean; mcapUsd: number | null; lastTradeAt: string | null }> {
  const events = await latestVSolFor(mint);
  let coin: Awaited<ReturnType<typeof fetchPumpFunCoin>> = null;
  try {
    coin = await fetchPumpFunCoin(mint);
  } catch {
    /* offline / non-pump — fall back to on-chain events */
  }
  const mcapUsd =
    coin?.usdMarketCap != null && Number.isFinite(coin.usdMarketCap) && coin.usdMarketCap > 0
      ? coin.usdMarketCap
      : null;
  const graduated = (coin?.bondingPct ?? 0) >= 100 || coin?.complete === true;
  // Carried for position marks: for a graduated coin this is the only "is anyone
  // still trading it" signal we have, since its trades are on PumpSwap and never
  // reach `events`. Free — the pump.fun fetch above is already cached 8s.
  const lastTradeAt = coin?.lastTradeAt ?? null;
  if (graduated) {
    const eff = effectiveVSolFromMcapUsd(mcapUsd);
    if (eff != null) return { vSol: eff, graduated: true, mcapUsd, lastTradeAt };
  }
  return { vSol: events, graduated, mcapUsd, lastTradeAt };
}

/**
 * Close any OPEN paper position when no session is active to manage it. A session
 * that stops (daily loss cap, manual Stop, worker restart) otherwise abandons its
 * open positions with no exit logic running — they hang open indefinitely. This
 * runs each idle tick and force-closes them at their last mark.
 */
/**
 * Final pre-execution gate. The tick reads the breaker once at the top, but an
 * entry pass then does many external round-trips (flow, DEX, insiders, pump API)
 * before it fills — so a HALT raised mid-tick would otherwise still open
 * positions. The live executor already re-checks via checkCaps(); paper had no
 * equivalent. Cheap because it only runs when a fill is imminent.
 */
async function haltedNow(): Promise<boolean> {
  // Logic (including the fail-closed branch) lives in lib/workers/halt-guard.ts
  // so it can be unit-tested without the database. This binds it to the real
  // breaker; behaviour is unchanged.
  return haltGuard(readState, (e) =>
    log.warn("breaker read failed before execution; treating as halted", { err: String(e) }),
  );
}

async function sweepOrphanedOpenPositions(): Promise<void> {
  const res = await getDb().execute(sql`
    SELECT id::text AS id, mint,
      current_price::float8 AS current_price,
      entry_price::float8 AS entry_price
    FROM paper_positions
    WHERE state = 'OPEN'
  `);
  const rows = (res as unknown as {
    rows: Array<{ id: string; mint: string; current_price: number | null; entry_price: number }>;
  }).rows;
  if (rows.length === 0) return;
  for (const pos of rows) {
    const price = pos.current_price != null && pos.current_price > 0 ? pos.current_price : pos.entry_price;
    const closed = await paperClose({
      positionId: BigInt(pos.id),
      reason: "session_ended",
      correlationId: `sweep-${pos.id}`,
      exitPriceOverride: price,
    });
    if (closed.ok) {
      log.info("swept orphaned open position (no active session)", {
        id: pos.id,
        mint: pos.mint,
        pnl: closed.data.realizedPnlSol.toFixed(4),
      });
    } else {
      log.warn("sweep close rejected", { id: pos.id, code: closed.code });
    }
  }
}

async function handleExits(session: AutoSessionDto) {
  const tpPct = session.params.takeProfitPct;
  const slPct = session.params.stopLossPct;
  const maxHoldMs = session.params.maxHoldMinutes * 60_000;
  // Multi-tier ladder (Kalacheva et al. 2026 §6.3). When tp1Pct is unset or
  // <= 0 the ladder is disabled and we fall back to single-TP behavior.
  const tp1Pct = session.params.tp1Pct ?? 0;
  const tp1Fraction = Math.max(0, Math.min(0.95, session.params.tp1Fraction ?? 0));
  const ladderOn = tp1Pct > 0 && tp1Fraction > 0 && tp1Pct < tpPct;
  // Trailing stop (L4): arm at +trailArmPct, then exit trailStopPct below peak.
  const trailArmPct = session.params.trailingArmPct ?? 0;
  const trailStopPct = session.params.trailingStopPct ?? 0;
  const trailingEnabled = trailArmPct > 0 && trailStopPct > 0;
  // Flat-position cut. Defaults reproduce the historical hard-code exactly:
  // 40% of max-hold, ceiling = the trail-arm threshold.
  const stagnationMs = Math.round(
    (session.params.stagnationMinutes ?? session.params.maxHoldMinutes * 0.4) * 60_000,
  );
  const stagnationMaxPeakPct = session.params.stagnationMaxPeakPct ?? trailArmPct;
  const budget = riskBudgetFor(env().RISK_PRESET);

  if (session.mode === "paper") {
    // Single-truth: paper_positions is the only paper ledger. TP1 partial
    // closes go through paperPartialClose; final closes through paperClose.
    // The paper portfolio + concurrency cap are GLOBAL (single ledger, id=1), so
    // exits must manage every OPEN position — not just the active session's.
    // Otherwise positions orphaned by a stopped session hold the global cap
    // forever and the next session can never open a trade. Stats are attributed
    // to each position's owning session (`pos_session_id`).
    const res = await getDb().execute(sql`
      SELECT id::text AS id, mint, notional_sol::float8 AS size_sol,
        entry_price::float8 AS entry_v_sol, current_price::float8 AS current_price, opened_at,
        modules_at_entry, entry_features,
        entry_features->>'session_id' AS pos_session_id,
        tp1_at_ts, tp1_realized_sol::float8 AS tp1_realized_sol,
        COALESCE(tp1_fraction, 0)::float8 AS tp1_fraction
      FROM paper_positions
      WHERE state = 'OPEN'
    `);
    type Raw = {
      id: string; mint: string; size_sol: number;
      entry_v_sol: number | null; current_price: number | null; opened_at: Date | string;
      modules_at_entry: Record<string, number> | null;
      entry_features: Record<string, unknown> | null;
      pos_session_id: string | null;
      tp1_at_ts: Date | string | null;
      tp1_realized_sol: number;
      tp1_fraction: number;
    };
    const rows = (res as unknown as { rows: Raw[] }).rows;

    // Research instrumentation (not a trading input): sample each open position's
    // P&L/health path ~every 30s so exit policies can be evaluated offline. The
    // curve-flow figures come from ONE batched query per tick; graduated coins
    // trade on PumpSwap and are absent from `events`, so theirs stay null and
    // `lastTradeAgeS` (pump.fun) is the liveness signal instead.
    const marks: PositionMarkInsert[] = [];
    const curveFlow = await fetchMintLaunchActivity(
      rows.map((r) => r.mint),
      60,
    ).catch(() => new Map<string, { tradeCount: number; uniqueWallets: number; maxVSol: number }>());

    for (const pos of rows) {
      if (pos.entry_v_sol == null) continue;
      // Attribute closed-trade stats to the position's OWNING session (it may
      // have been opened by a now-stopped session but still occupies the ledger).
      const statSession = pos.pos_session_id ?? session.id;
      const {
        vSol: current,
        graduated,
        mcapUsd: currentMcapUsd,
        lastTradeAt,
      } = await resolveCurrentForExit(pos.mint);
      if (current == null) {
        // Dead/illiquid mint: no live price feed. Don't let it hold a
        // concurrency slot forever — once past max hold, force-close at the
        // last known mark (or entry as a conservative fallback) so capital and
        // the slot are freed for fresh launches. (Was: `continue` → stuck OPEN.)
        const openedAtMs =
          pos.opened_at instanceof Date ? pos.opened_at.getTime() : new Date(pos.opened_at).getTime();
        const staleAgeMs = Date.now() - openedAtMs;
        if (staleAgeMs < maxHoldMs) continue;
        const fallbackPrice =
          pos.current_price != null && pos.current_price > 0 ? pos.current_price : pos.entry_v_sol;
        const id = BigInt(pos.id);
        const closed = await paperClose({
          positionId: id,
          reason: "timeout_stale",
          correlationId: `close-stale-${pos.id}`,
          exitPriceOverride: fallbackPrice,
        });
        if (!closed.ok) {
          log.warn("paper stale force-close rejected", { id: pos.id, code: closed.code, reason: closed.reason });
          continue;
        }
        const finalPnl = (pos.tp1_realized_sol ?? 0) + closed.data.realizedPnlSol;
        await recordOutcome({
          source: "paper",
          tradeId: id,
          entryVSol: pos.entry_v_sol,
          exitVSol: closed.data.exitPrice,
          pnlSol: finalPnl,
          pctOfSize: closed.data.pctOfSize,
          exitReason: "timeout_stale",
          holdSeconds: staleAgeMs / 1000,
          action: ((pos.entry_features as Record<string, unknown> | null)?.action as string) ?? null,
          modulesAtEntry: pos.modules_at_entry,
        });
        // Post-exit telemetry: snapshot at the close so label-builder matures
        // forward 5m/30m/1h/6h returns vs exit price — exit-quality signal.
        await recordPostExitSnapshot({
          mint: pos.mint,
          positionId: pos.id,
          exitVSol: closed.data.exitPrice,
          exitReason: "timeout_stale",
        }).catch(() => undefined);
        const win = finalPnl > 0;
        await accumulateStat(statSession, win ? "wins" : "losses", 1);
        await accumulateStat(statSession, "tradesClosed", 1);
        await accumulateStat(statSession, "realizedPnlSol", finalPnl);
        log.info("auto closed paper (stale/no price)", {
          id: pos.id, mint: pos.mint, reason: "timeout_stale",
          ageHrs: (staleAgeMs / 3_600_000).toFixed(1),
          exitPrice: fallbackPrice, pnl: finalPnl.toFixed(4),
        });
        continue;
      }
      const openedAt =
        pos.opened_at instanceof Date ? pos.opened_at.getTime() : new Date(pos.opened_at).getTime();
      const now = Date.now();
      const ageMs = now - openedAt;

      // Prefer REAL market-cap PnL (pump/DEX) when we have a real entry mcap and a
      // live current mcap — accurate on AND off the bonding curve. Otherwise fall
      // back to the bonding-curve vSol model. `realizedExitPrice` is the vSol fed
      // to the curve close (value ∝ vSol²) so the booked PnL matches the chosen model.
      const efPnl = (pos.entry_features ?? {}) as Record<string, unknown>;
      let entryMcapStamp =
        typeof efPnl.entry_mcap_usd === "number" && efPnl.entry_mcap_usd > 0
          ? (efPnl.entry_mcap_usd as number)
          : null;
      let entryMcapIsReal = efPnl.entry_mcap_real === true;
      // Backfill: the open-path pump fetch is best-effort (short timeout under load).
      // The first exit tick after a young open reliably has a cached real mcap — use
      // it as the real entry mcap so every position gets an accurate entry value.
      if (!entryMcapIsReal && currentMcapUsd != null && currentMcapUsd > 0 && ageMs < 45_000) {
        entryMcapStamp = currentMcapUsd;
        entryMcapIsReal = true;
        await getDb()
          .execute(sql`
            UPDATE paper_positions
            SET entry_features = COALESCE(entry_features, '{}'::jsonb)
              || jsonb_build_object('entry_mcap_usd', ${currentMcapUsd}::float8,
                                    'entry_mcap_real', true)
            WHERE id = ${BigInt(pos.id)}
          `)
          .catch(() => undefined);
      }
      // Single pricing seam (lib/pricing/seam.ts): prefers the real-mcap model
      // (accurate on/off curve) when we have a real entry mcap + live mcap, else
      // the bonding-curve vSol model. Invariants locked by lib/pricing/seam.test.ts.
      const mark = markPnl({
        sizeSol: pos.size_sol,
        entryVSol: pos.entry_v_sol,
        currentVSol: current,
        entryMcapUsd: entryMcapStamp,
        currentMcapUsd,
        entryMcapReal: entryMcapIsReal,
        graduated,
        pumpFeesPct: budget.pumpFeesPct,
        paperSlippagePct: budget.paperSlippagePct,
      });
      const pnlSol = mark.pnlSol;
      const pctOfSize = mark.pctOfSize;
      const realizedExitPrice = mark.realizedExitVSol ?? undefined;

      // Profit-curve capture: track peak unrealized PnL (and when) in
      // entry_features. Feeds the trailing stop and the learner's exit-timing.
      const ef = (pos.entry_features ?? {}) as Record<string, unknown>;
      const prevPeak = typeof ef.peak_pct === "number" ? (ef.peak_pct as number) : -Infinity;
      const peakPct = Math.max(prevPeak, pctOfSize);
      if (pctOfSize > prevPeak) {
        await getDb()
          .execute(sql`
            UPDATE paper_positions
            SET entry_features = COALESCE(entry_features, '{}'::jsonb)
              || jsonb_build_object('peak_pct', ${pctOfSize}::float8,
                                    'peak_at_ms', ${ageMs}::float8)
            WHERE id = ${BigInt(pos.id)}
          `)
          .catch(() => undefined);
      }

      const tp1HitAt = pos.tp1_at_ts != null;
      const tp1Realized = pos.tp1_realized_sol ?? 0;
      const tp1FractionExisting = pos.tp1_fraction ?? 0;
      const id = BigInt(pos.id);

      // Sample the path ~every 30s (see lib/paper/position-marks.ts). Recording
      // only; nothing here influences the exit decision below.
      const lastMarkAt = typeof ef.last_mark_at_ms === "number" ? (ef.last_mark_at_ms as number) : null;
      if (shouldMark(lastMarkAt, now)) {
        const flow = graduated ? null : (curveFlow.get(pos.mint) ?? null);
        marks.push({
          positionId: id,
          ageS: Math.round(ageMs / 1000),
          pct: pctOfSize,
          peakPct,
          mcapUsd: currentMcapUsd,
          graduated,
          lastTradeAgeS: ageSeconds(lastTradeAt, now),
          curveTrades60s: flow?.tradeCount ?? null,
          curveWallets60s: flow?.uniqueWallets ?? null,
        });
        await getDb()
          .execute(sql`
            UPDATE paper_positions
            SET entry_features = COALESCE(entry_features, '{}'::jsonb)
              || jsonb_build_object('last_mark_at_ms', ${now}::float8)
            WHERE id = ${id}
          `)
          .catch(() => undefined);
      }

      // T3.3 — genesis trades use a moon-tail-preserving exit: wide rug-cut SL
      // only, no TP / no trail / no stagnation / no TP1 ladder. The exit backtest
      // proved that any tail-clipping exit destroys total return (the edge is the
      // few moonshots). So genesis skips the ladder entirely and holds to max-hold.
      const isGenesis = ef.genesis_snipe === true;

      // ── TP1 partial via the new engine (no manual jsonb stamping) ──
      if (ladderOn && !isGenesis && !tp1HitAt && pctOfSize >= tp1Pct) {
        const partial = await paperPartialClose({
          positionId: id,
          fraction: tp1Fraction,
          reason: "tp1",
          correlationId: `tp1-${id}`,
          exitPriceOverride: realizedExitPrice,
        });
        if (partial.ok) {
          const realized = partial.data.realizedPnlSol;
          log.info("auto paper TP1 partial", {
            id: pos.id, mint: pos.mint,
            pctOfSize: pctOfSize.toFixed(3), realized: realized.toFixed(4),
          });
          await notify({
            kind: "trade_win",
            title: `TP1 partial on ${pos.mint.slice(0, 6)}…`,
            body: `Locked +${realized.toFixed(4)} SOL · letting the rest ride`,
            mint: pos.mint,
            pnlSol: realized,
            extra: { sessionId: session.id },
          });
        } else {
          log.warn("paper TP1 partial rejected", { id: pos.id, code: partial.code, reason: partial.reason });
        }
        continue;
      }

      // Exit logic: stop-loss → trailing stop (lets armed winners RUN, no fixed cap)
      // → fixed TP for small non-armed winners → stagnation cut → max-hold.
      // T3.3 — genesis trades override with a tail-preserving policy (wide SL only).
      const exit = isGenesis
        ? decidePaperExit(pctOfSize, peakPct, ageMs, {
            tpPct: Number.POSITIVE_INFINITY, // never cap a moon
            slPct: env().GENESIS_EXIT_SL_PCT, // wide catastrophic rug-cut only
            maxHoldMs: env().GENESIS_EXIT_MAX_HOLD_MIN * 60_000,
            trailArmPct: 0, // no trailing — would clip the tail
            trailStopPct: 0,
            stagnationMs: 0, // no stagnation cut — a flat coin may still moon
          })
        : decidePaperExit(pctOfSize, peakPct, ageMs, {
            tpPct,
            slPct,
            maxHoldMs,
            trailArmPct: trailingEnabled ? trailArmPct : 0,
            trailStopPct: trailingEnabled ? trailStopPct : 0,
            // Free capital from coins that never built momentum.
            stagnationMs: trailingEnabled ? stagnationMs : 0,
            stagnationMaxPeakPct,
          });
      if (!exit) continue;

      const reason = tp1HitAt ? `${exit}+tp1` : exit;
      const closed = await paperClose({
        positionId: id,
        reason,
        correlationId: `close-${id}`,
        // Book at the price matching our PnL model: real-mcap-derived when we have
        // real mcaps (accurate on/off curve), else the graduated DEX-derived vSol.
        exitPriceOverride: realizedExitPrice,
      });
      if (!closed.ok) {
        log.warn("paper close rejected", { id: pos.id, code: closed.code, reason: closed.reason });
        continue;
      }
      // Final realized PnL = TP1 realized (already locked in by partial close)
      // + the residual realized by paperClose on the remaining quantity.
      const finalPnl = tp1Realized + closed.data.realizedPnlSol;
      await recordOutcome({
        source: "paper",
        tradeId: id,
        entryVSol: pos.entry_v_sol,
        exitVSol: closed.data.exitPrice,
        pnlSol: finalPnl,
        pctOfSize: closed.data.pctOfSize,
        exitReason: reason,
        holdSeconds: ageMs / 1000,
        action: ((pos.entry_features as Record<string, unknown> | null)?.action as string) ?? null,
        modulesAtEntry: pos.modules_at_entry,
      });
      // Post-exit telemetry: snapshot at exit so the existing label-builder
      // matures forward returns (ret_5m/30m/1h + maxGain/Drawdown/isRug) vs the
      // exit price. Lets us answer "did the coin go up after we sold?" without
      // any new infra. Best-effort — must not block the close.
      await recordPostExitSnapshot({
        mint: pos.mint,
        positionId: pos.id,
        exitVSol: closed.data.exitPrice,
        exitMcapUsd: currentMcapUsd ?? null,
        exitReason: reason,
      }).catch(() => undefined);
      // 3-layer causal attribution (L5.1): split PnL into edge/execution/market
      // so the learner never blames strategy for execution slippage or rugs.
      const execSlipBps = typeof ef.exec_slippage_bps === "number" ? (ef.exec_slippage_bps as number) : null;
      const rugScoreAtEntry = (pos.modules_at_entry?.M3_RUG ?? 0) as number;
      const attribution = attributePnl({
        pnlSol: finalPnl,
        sizeSol: pos.size_sol,
        execSlippageBps: execSlipBps,
        rugDriven: rugScoreAtEntry >= 0.5 || reason.includes("rug"),
      });
      await getDb()
        .execute(sql`
          UPDATE paper_positions
          SET entry_features = COALESCE(entry_features, '{}'::jsonb) || ${JSON.stringify(attributionFields(attribution))}::jsonb
          WHERE id = ${id}
        `)
        .catch(() => undefined);

      const win = finalPnl > 0;
      await accumulateStat(statSession, win ? "wins" : "losses", 1);
      await accumulateStat(statSession, "tradesClosed", 1);
      await accumulateStat(statSession, "realizedPnlSol", finalPnl);
      log.info("auto closed paper", {
        id: pos.id, mint: pos.mint, reason, pnl: finalPnl.toFixed(4),
        tp1: tp1HitAt ? "yes" : "no", tp1Fraction: tp1FractionExisting,
        peakPct: Number.isFinite(peakPct) ? peakPct.toFixed(3) : "n/a",
      });
      await notify({
        kind: finalPnl >= 0 ? "trade_win" : "trade_loss",
        title: `Auto ${reason.toUpperCase()} on ${pos.mint.slice(0, 6)}…`,
        body: `${finalPnl >= 0 ? "+" : ""}${finalPnl.toFixed(4)} SOL · paper session`,
        mint: pos.mint,
        pnlSol: finalPnl,
        extra: { sessionId: session.id },
      });
    }
    // One batched insert per tick. Best-effort: instrumentation must never
    // interfere with exits.
    if (marks.length) {
      await insertPositionMarks(marks).catch((e) =>
        log.warn("position marks insert failed", { err: String(e), n: marks.length }),
      );
    }
    return;
  }

  // Live exits — skip pending_close / close_failed (sell-all claims those rows).
  const open = await fetchOpenLivePositions();
  for (const pos of open) {
    if ((pos.sessionId ?? null) !== session.id) continue;
    let entryV = pos.entryPrice;
    if (entryV == null) {
      const ef = pos.entryFeatures as Record<string, unknown> | null;
      const fromFeat = ef?.entry_v_sol;
      if (typeof fromFeat === "number" && fromFeat > 0) entryV = fromFeat;
    }
    if (entryV == null) continue;
    const current = await latestVSolFor(pos.mint);
    if (current == null) continue;
    const fees = pos.sizeSol * 0.01 * 2;
    // Bonding-curve: position value scales as (vSol_now / vSol_entry)², not linearly.
    const grossPct = (current / entryV) ** 2 - 1;
    const pctOfSize = grossPct - 0.02; // rough fees
    const pnlSol = pctOfSize * pos.sizeSol;
    const openedAt = pos.openedAt instanceof Date ? pos.openedAt.getTime() : Date.now();
    const ageMs = Date.now() - openedAt;

    const features = (pos.entryFeatures as Record<string, unknown> | null) ?? {};
    const tp1HitAt = features.tp1_hit_at as string | undefined;
    const tp1Realized = (features.tp1_realized_sol as number | undefined) ?? 0;

    // ── Partial TP1 (live ladder) ──
    if (ladderOn && !tp1HitAt && pctOfSize >= tp1Pct) {
      const tp1Pnl = pnlSol * tp1Fraction;
      // Persist the partial first so a crash mid-sell doesn't double-fire.
      await getDb().execute(sql`
        UPDATE live_trades
        SET entry_features = COALESCE(entry_features, '{}'::jsonb)
          || jsonb_build_object(
            'tp1_hit_at',     ${new Date().toISOString()},
            'tp1_pct_of_size',${pctOfSize}::float,
            'tp1_v_sol',      ${current}::float,
            'tp1_realized_sol', ${tp1Pnl}::float,
            'tp1_fraction',    ${tp1Fraction}::float
          )
        WHERE id = ${pos.id}
      `);
      if (pos.dryRun) {
        log.info("auto dry-run TP1 partial", {
          id: pos.id.toString(), realized: tp1Pnl.toFixed(4),
        });
      } else {
        const liveGate = await assertLiveExecutionAllowed();
        if (!liveGate.ok) {
          await markSessionError(`live blocked: ${liveGate.reason}`);
          return;
        }
        const kp = peekKeypair();
        const rpcs = rpcHttpUrls();
        if (!kp || rpcs.length === 0) {
          await markSessionError("wallet/rpc unavailable during TP1");
          return;
        }
        const sellPct = Math.max(1, Math.min(99, Math.round(tp1Fraction * 100)));
        const sellRes = await executeLiveSell({
          mint: pos.mint, percent: sellPct, keypair: kp, rpcUrl: rpcs[0]!,
        });
        if (sellRes.ok) {
          log.info("auto live TP1 partial", {
            id: pos.id.toString(),
            sellPct, realized: tp1Pnl.toFixed(4), route: sellRes.route,
          });
          await notify({
            kind: "trade_win",
            title: `TP1 partial on ${pos.mint.slice(0, 6)}…`,
            body: `Sold ${sellPct}% · realized +${tp1Pnl.toFixed(4)} SOL · letting the rest ride`,
            mint: pos.mint,
            pnlSol: tp1Pnl,
          });
        } else {
          log.warn("auto live TP1 sell failed", { mint: pos.mint, err: sellRes.error });
        }
      }
      continue;
    }

    const exit =
      pctOfSize >= tpPct ? "tp"
      : pctOfSize <= -slPct ? "sl"
      : ageMs >= maxHoldMs ? "timeout"
      : null;
    if (!exit) continue;

    // Final close — settle the residual.
    const residualFraction = tp1HitAt ? 1 - tp1Fraction : 1;
    const finalPnl = tp1Realized + pnlSol * residualFraction;
    const reason = tp1HitAt ? `${exit}+tp1` : exit;

    if (pos.dryRun) {
      await closeLivePosition({
        id: pos.id,
        exitPrice: current,
        pnlSol: finalPnl,
        feesSol: fees,
        exitReason: reason,
      });
      await accumulateStat(session.id, "tradesClosed", 1);
      await accumulateStat(session.id, finalPnl > 0 ? "wins" : "losses", 1);
      await accumulateStat(session.id, "realizedPnlSol", finalPnl);
      log.info("auto dry-closed live", {
        id: pos.id.toString(), reason, pnl: finalPnl.toFixed(4),
      });
    } else {
      const liveGate = await assertLiveExecutionAllowed();
      if (!liveGate.ok) {
        await markSessionError(`live blocked: ${liveGate.reason}`);
        return;
      }
      const kp = peekKeypair();
      const rpcs = rpcHttpUrls();
      if (!kp || rpcs.length === 0) {
        await markSessionError("wallet/rpc unavailable during exit");
        return;
      }
      const sellRes = await executeLiveSell({
        mint: pos.mint,
        percent: 100,
        keypair: kp,
        rpcUrl: rpcs[0]!,
      });
      if (sellRes.ok) {
        await closeLivePosition({
          id: pos.id,
          exitPrice: current,
          pnlSol: finalPnl,
          feesSol: fees,
          exitReason: reason,
          txSignatureClose: sellRes.signature ?? sellRes.simulatedSignature ?? null,
        });
        await accumulateStat(session.id, "tradesClosed", 1);
        await accumulateStat(session.id, finalPnl > 0 ? "wins" : "losses", 1);
        await accumulateStat(session.id, "realizedPnlSol", finalPnl);
        log.info("auto closed live", {
          id: pos.id.toString(),
          reason,
          pnl: finalPnl.toFixed(4),
          route: sellRes.route,
        });
        await notify({
          kind: finalPnl >= 0 ? "trade_win" : "trade_loss",
          title: `Auto-trade ${reason.toUpperCase()} on ${pos.mint.slice(0, 6)}…`,
          body: `${finalPnl >= 0 ? "+" : ""}${finalPnl.toFixed(4)} SOL · ${sellRes.route}${sellRes.dryRun ? " (dry-run)" : ""}`,
          mint: pos.mint,
          pnlSol: finalPnl,
        });
      } else {
        log.warn("auto live sell failed", { mint: pos.mint, err: sellRes.error });
      }
    }
  }
}

async function accumulateStat(
  sessionId: string,
  key: "tradesOpened" | "tradesClosed" | "wins" | "losses" | "realizedPnlSol",
  delta: number,
) {
  const k = key.replace(/'/g, "''");
  const sid = BigInt(sessionId).toString();
  await getDb().execute(
    sql.raw(`
    UPDATE auto_sessions
    SET stats = jsonb_set(
      stats,
      '{${k}}',
      to_jsonb(COALESCE((stats->>'${k}')::float8, 0) + ${delta})
    )
    WHERE id = ${sid}
  `),
  );
}

async function fetchMintFlow(mint: string) {
  const windowMin = activeMintWindowMinutes();
  const res = await getDb().execute(sql`
    WITH flow AS (
      SELECT
        COUNT(*) FILTER (WHERE kind = 'buy' AND ts > now() - interval '5 minutes')::int AS buys_5m,
        COUNT(*) FILTER (WHERE kind = 'sell' AND ts > now() - interval '5 minutes')::int AS sells_5m,
        COUNT(DISTINCT wallet) FILTER (WHERE kind = 'buy' AND ts > now() - interval '5 minutes')::int AS unique_buyers_5m
      FROM events
      WHERE mint = ${mint}
        AND ts > now() - (${sql.raw(String(windowMin))} || ' minutes')::interval
        AND kind IN ('buy', 'sell')
    )
    SELECT
      f.buys_5m,
      f.sells_5m,
      f.unique_buyers_5m,
      (SELECT EXTRACT(EPOCH FROM (now() - created_at))::float8 FROM tokens WHERE mint = ${mint}) AS token_age,
      (SELECT EXTRACT(EPOCH FROM (now() - last_trade_at))::float8 FROM trend_candidates WHERE mint = ${mint}) AS trend_age,
      (SELECT EXTRACT(EPOCH FROM (now() - MIN(ts)))::float8 FROM events
        WHERE mint = ${mint}
          AND ts > now() - (${sql.raw(String(windowMin))} || ' minutes')::interval
          AND kind IN ('buy', 'sell', 'snapshot')) AS first_event_age,
      (SELECT EXTRACT(EPOCH FROM (now() - MAX(ts)))::float8 FROM events
        WHERE mint = ${mint}
          AND kind = 'snapshot'
          AND ts > now() - (${sql.raw(String(windowMin))} || ' minutes')::interval) AS last_snapshot_age
    FROM flow f
  `);
  const r = (res as unknown as {
    rows: Array<{
      buys_5m: number;
      sells_5m: number;
      unique_buyers_5m: number;
      token_age: number | null;
      trend_age: number | null;
      first_event_age: number | null;
      last_snapshot_age: number | null;
    }>;
  }).rows[0];
  const ageSeconds = coalesceFlowAgeSeconds({
    token_age: r?.token_age ?? null,
    trend_age: r?.trend_age ?? null,
    first_event_age: r?.first_event_age ?? null,
    last_snapshot_age: r?.last_snapshot_age ?? null,
  });
  return {
    buys5m: r?.buys_5m ?? 0,
    sells5m: r?.sells_5m ?? 0,
    uniqueBuyers5m: r?.unique_buyers_5m ?? 0,
    buyVol5m: null,
    sellVol5m: null,
    curveVelocity5m: null,
    ageSeconds,
  };
}

type EntryTickStats = {
  pendingCount: number;
  opened: number;
  topSkipReasons: string[];
  recentFilterSkips: Array<{ ts: string; mint: string; reason: string }>;
};

/**
 * Genesis-sniper entry path (2026-06-15) — parallel to handleEntries.
 *
 * The DEX-flow filter chain in handleEntries (dexBuysM5 floor, MAX_ENTRY_MCAP)
 * mechanically rejects fresh on-curve mints — DexScreener has no data yet, and
 * pump.fun mcap on a 30s-old coin is under $5k. But the 6,133-buy elite-wallet
 * analysis and the 27,493-mint backtest both showed: the proven winning regime
 * is buying at vSol 18–60 within 5–60s of launch. This function is the entry
 * path that targets that regime, gated by env.GENESIS_SNIPER=on.
 *
 * Bypasses qualifyEntry/passesConfluence/MAX_ENTRY_MCAP_USD by design — those
 * are post-grad gates that would reject every fresh-curve mint. Genesis trades
 * are stamped `entry_features.genesis_snipe=true` so the post-exit poller and
 * any future analysis can attribute outcomes back to this path cleanly.
 */
async function handleGenesisEntries(session: AutoSessionDto): Promise<number> {
  if (env().GENESIS_SNIPER !== "on") return 0;
  if (session.mode !== "paper") return 0;  // paper only until proven

  // Capacity check — same logic as handleEntries, share the global cap.
  const own = await fetchOpenOwnershipCounts(session.id);
  const globalCap = getPaperConfig().maxOpenPositions;
  const remaining = entryHeadroom({
    sessionMaxConcurrent: session.params.maxConcurrent,
    ownedByActive: own.ownedByActive,
    globalCap,
    totalOpen: own.total,
    applyGlobalCap: true,
  });
  if (remaining <= 0) return 0;

  const candidates = await fetchGenesisSnipeCandidates({
    maxAgeSec: env().GENESIS_SNIPER_MAX_AGE_SEC,
    limit: 30,
  });
  if (!candidates.length) return 0;

  const heldMints = await fetchOpenMintsForSession(session.id);
  const size = env().GENESIS_SNIPER_SIZE_SOL;
  if (size <= 0) return 0;

  let opened = 0;
  for (const sig of candidates) {
    if (opened >= remaining) break;
    if (heldMints.has(sig.mint)) continue;

    const dec = evaluateGenesisSnipe(sig);
    if (!dec.fire) continue;

    const bsr = sig.buyVolSol30s + sig.sellVolSol30s > 0
      ? sig.buyVolSol30s / (sig.buyVolSol30s + sig.sellVolSol30s)
      : 1;

    const entryFeatures: Record<string, unknown> = {
      session_id: session.id,
      session_mode: "paper",
      auto: true,
      action: "BUY_STRONG",
      genesis_snipe: true,
      genesis_confidence: dec.confidence,
      genesis_bucket: dec.vSolBucket,
      entry_tier: "strict",
      entry_age_seconds: sig.ageSec,
      entry_v_sol: sig.currentVSol,
      genesis_buys_30s: sig.buys30s,
      genesis_sells_30s: sig.sells30s,
      genesis_unique_buyers_30s: sig.uniqueBuyers30s,
      genesis_buy_sell_ratio: bsr,
      genesis_buy_vol_sol_30s: sig.buyVolSol30s,
    };

    const intent: TradeIntent = {
      intentId: `genesis-${sig.mint.slice(0, 8)}-${Date.now()}`,
      mint: sig.mint,
      side: "buy",
      mode: "paper",
      sizeSol: size,
      reason: "BUY_STRONG",
      tier: "strict",
      regime: getCurrentRegime().regime,
      createdAtMs: Date.now(),
    };
    const plan = buildExecutionPlan(intent, {
      route: "paper",
      expectedPriceSol: sig.currentVSol,
      maxSlippageBps: env().LIVE_SLIPPAGE_BPS,
      priorityFeeSol: 0,
      poolLiquiditySol: sig.currentVSol,
    });

    if (await haltedNow()) {
      log.warn("halt raised mid-tick — abandoning genesis entries", { mint: sig.mint });
      break;
    }

    try {
      const { outcome, positionId } = await executePaperBuy(plan, {
        mint: sig.mint,
        symbol: null,
        sizeSol: size,
        takeProfitPct: session.params.takeProfitPct ?? undefined,
        stopLossPct: session.params.stopLossPct ?? undefined,
        correlationId: `genesis-${sig.mint.slice(0, 8)}-${Date.now()}`,
        decisionId: null,
        entryFeatures,
        modulesAtEntry: null,
        meta: { sessionId: session.id, kind: "genesis_snipe" },
      });
      if (outcome.status === "filled" && positionId != null) {
        opened++;
        await accumulateStat(session.id, "tradesOpened", 1);
        log.info("genesis-snipe opened", {
          mint: sig.mint, vSol: sig.currentVSol.toFixed(1),
          age: sig.ageSec.toFixed(0), conf: dec.confidence.toFixed(2),
          bucket: dec.vSolBucket, buys30s: sig.buys30s, uniq: sig.uniqueBuyers30s,
        });
      } else {
        log.info("genesis-snipe rejected by executor", {
          mint: sig.mint, status: outcome.status, reason: outcome.rejectReason,
        });
      }
    } catch (e) {
      log.warn("genesis-snipe open failed", { mint: sig.mint, err: String(e) });
    }
  }
  return opened;
}

async function handleEntries(session: AutoSessionDto): Promise<EntryTickStats> {
  const transientSkips = new Map<string, number>();
  const recentFilterSkips: Array<{ ts: string; mint: string; reason: string }> = [];
  const bumpTransient = (mint: string, reason: string) => {
    transientSkips.set(reason, (transientSkips.get(reason) ?? 0) + 1);
    if (recentFilterSkips.length < 12) {
      recentFilterSkips.push({
        ts: new Date().toISOString(),
        mint,
        reason: reason.slice(0, 100),
      });
    }
  };

  // Capacity check. Paper sessions are bounded by BOTH their own concurrency cap
  // AND the global paper-ledger cap (issue #11): orphaned OPEN positions from a
  // stopped session consume the kernel's maxOpenPositions, so counting only this
  // session's positions would make us attempt opens the kernel will reject.
  let remaining: number;
  if (session.mode === "paper") {
    const own = await fetchOpenOwnershipCounts(session.id);
    const globalCap = getPaperConfig().maxOpenPositions;
    remaining = entryHeadroom({
      sessionMaxConcurrent: session.params.maxConcurrent,
      ownedByActive: own.ownedByActive,
      globalCap,
      totalOpen: own.total,
      applyGlobalCap: true,
    });
    if (remaining <= 0 && own.orphaned > 0 && own.total >= globalCap) {
      // Log only when the orphan count changes, or at most once every 5 min —
      // these positions self-clear (stagnation/max-hold), so per-tick spam is noise.
      const now = Date.now();
      if (own.orphaned !== lastOrphanCount || now - lastOrphanWarnAt > 300_000) {
        log.warn("global paper cap held by orphaned positions from a stopped session (they self-clear at stagnation/max-hold)", {
          orphaned: own.orphaned,
          ownedByActive: own.ownedByActive,
          total: own.total,
          globalCap,
        });
        lastOrphanWarnAt = now;
        lastOrphanCount = own.orphaned;
      }
    }
  } else {
    const openCount = await openCountForSession(session);
    remaining = Math.max(0, session.params.maxConcurrent - openCount);
  }
  if (remaining <= 0) {
    return { pendingCount: 0, opened: 0, topSkipReasons: [], recentFilterSkips: [] };
  }

  const pendings = strictFirst(await resolvePendingBuyQueue());
  if (pendings.length === 0) {
    return { pendingCount: 0, opened: 0, topSkipReasons: [], recentFilterSkips: [] };
  }

  const heldMints = await fetchOpenMintsForSession(session.id);
  const skipAlreadyHeld: bigint[] = [];
  const skipFiltered: bigint[] = [];
  const skipNoPrice: bigint[] = [];
  const skipFilter: bigint[] = [];

  let opened = 0;
  const skipRugLabel: bigint[] = [];
  const skipInsufficientDemo: bigint[] = [];
  const tagDemo = session.mode === "paper" && (await getUiTradingMode()) !== "real";
  let demoBalanceCache: number | null = null;
  const pendingMints = [...new Set(pendings.map((d) => d.mint))];
  let rugsByMint = new Map<string, string>();
  try {
    const rugs = await fetchRugLabels(pendingMints);
    rugsByMint = new Map([...rugs.entries()].map(([m, r]) => [m, r.label]));
  } catch (e) {
    log.warn("fetch rug labels failed", { err: String(e) });
  }
  const vSolBatch = await latestVSolBatch(pendingMints);
  const demoRelaxed = tagDemo && autoDemoRelaxEnabled();
  // V2-simple entry (SYSTEM_DESIGN §IV.8): the soft selection gates below
  // (max-entry-age, order-flow veto, activity floor) are the "complexity" the
  // ablation found harmful — bypass them. Hard safety vetoes (rugged label,
  // bundle/mechanical) below are kept.
  const v2Mode = isV2SimpleEntry();
  for (const d of pendings) {
    if (opened >= remaining) break;
    if (heldMints.has(d.mint)) {
      skipAlreadyHeld.push(d.id);
      continue;
    }
    if (!shouldAcceptAction(d.action, session.params.signalStrictness)) {
      skipFiltered.push(d.id);
      continue;
    }
    const rugLabel = rugsByMint.get(d.mint);
    if (rugLabel === "rugged") {
      skipRugLabel.push(d.id);
      continue;
    }
    const v =
      vSolHintFromModules(d.moduleScores as Record<string, number>) ??
      vSolBatch.get(d.mint) ??
      (await resolveEntryVSol(d.mint, {
        decisionTs: d.ts,
        hintVSol: null,
      }));
    if (v == null || v <= 0) {
      bumpTransient(d.mint, "no live price yet");
      const ageMs = Date.now() - new Date(d.ts).getTime();
      if (ageMs > 120_000) skipNoPrice.push(d.id);
      continue;
    }

    // === Paper-aligned three-gate (Luo et al. WWW '26 §5.1.3) =============
    // Live mode applies a hard Bundle/MechanicalUptrend veto. Demo/paper
    // with AUTO_DEMO_RELAX=on records the flag but lets the trade open so
    // the operator can observe how the system would have behaved.
    const flags = await fetchMintFlags(d.mint);
    if (flags?.hasBundle || flags?.mechanicalUptrend) {
      if (session.mode === "live" || !autoDemoRelaxEnabled()) {
        bumpTransient(d.mint, "bundle/mechanical");
        continue;
      }
      log.info("demo bypass bundle/mechanical", {
        mint: d.mint,
        hasBundle: !!flags?.hasBundle,
        mechanical: !!flags?.mechanicalUptrend,
      });
    }
    // Regime-linked sizing (L6.2): risk less in rug-heavy/thin regimes.
    const regimeRisk = getCurrentRegime().riskMultiplier;
    const baseSize = regimeSizedSol(session.params.sizeSol, regimeRisk);
    const sizeSol = Math.min(
      baseSize,
      session.mode === "live" ? env().LIVE_MAX_PER_TRADE_SOL : baseSize,
    );

    const flowData = await fetchMintFlow(d.mint);
    const timingAge = resolveTimingAgeSeconds(flowData.ageSeconds, d.ts);

    // Entry-age ceiling (data-driven from eval-paper): coins entered older than
    // ~1 min lose heavily (1–5 min bucket ≈ −7.5%) while fresh entries win — late
    // entries buy the top. Skip stale candidates when MAX_ENTRY_AGE_SEC is set.
    const maxEntryAge = v2Mode ? 0 : env().MAX_ENTRY_AGE_SEC;
    if (maxEntryAge > 0 && timingAge != null && timingAge > maxEntryAge) {
      bumpTransient(d.mint, `too old (${Math.round(timingAge)}s > ${maxEntryAge}s)`);
      continue;
    }

    // Order-flow at entry. Most traded coins are DEX-discovered and have NO
    // trade-level rows in our bonding-curve `events` feed, so fetchMintFlow above
    // is blind for them. DexScreener 5m aggregates are the only flow signal we
    // have — capture them for the learner AND use them for a conservative gate.
    const dexSnap = (await fetchDexMarketBatchCached([d.mint]).catch(() => null))?.get(d.mint) ?? null;
    // DEX order-flow gate. The BASELINE half runs in every mode including
    // v2_simple -- v2 reduces entry to "intelligence >= 0.5 AND rug < 0.7", which
    // was buying coins with 0 buys and $0 of 5m volume. The momentum half is
    // opt-in per session (the "momentum" preset). Mints with no DEX snapshot are
    // untouched, so fresh-curve and genesis entries are unaffected.
    const flow = passesFlowGate(dexSnap, flowThresholdsFor(session.params));
    if (!flow.allow) {
      log.info("auto skipped (flow)", { mint: d.mint, reason: flow.reason });
      bumpTransient(d.mint, flow.reason);
      continue;
    }
    const insider = await analyzeMintInsiders(d.mint);
    // Entry-activity floor (data-driven, refined 2026-06-15 on 320 trades). Require,
    // for DEX-flow coins (dexSnap present), real 5m activity — high buy count OR a
    // smart-money buyer. Pure bonding-curve newborns with no DexScreener data are
    // unaffected. No momentum gate: winners actually had NEGATIVE 5m change at entry
    // (buying already-pumping coins = local top). Env-tunable; 0 disables.
    const minDexBuys = v2Mode ? 0 : env().ENTRY_MIN_DEX_BUYS_M5;
    if (minDexBuys > 0 && dexSnap) {
      const buys = dexSnap.buysM5 ?? 0;
      const hasSmart = insider.smartMoneyCount >= 1;
      if (buys < minDexBuys && !hasSmart) {
        const reason = `low activity (buys=${buys}/${minDexBuys} smc=${insider.smartMoneyCount})`;
        log.info("auto skipped (activity floor)", { mint: d.mint, reason });
        bumpTransient(d.mint, reason);
        continue;
      }
    }
    const entryCtx = {
      mint: d.mint,
      action: d.action,
      confluenceScore: d.confluenceScore ?? 0,
      moduleScores: d.moduleScores as Record<string, number> | null,
      vSol: v,
      sizeSol,
      ageSeconds: timingAge,
      flow: flowData,
      flags,
      insider,
      takeProfitPct: session.params.takeProfitPct,
    };
    // Strict-first tiering: strict-allowed decisions use the strict entry path;
    // only non-strict decisions fall back to the relaxed (demo) path, and only
    // when AUTO_DEMO_RELAX is on. entry_tier is tagged for learner attribution.
    const strictAllowed = isStrictAllowed(d);
    // Relaxed tier may be disabled by the learner when it underperforms (L5.4).
    const useRelaxed = demoRelaxed && !strictAllowed && relaxedTierEnabled();
    const entryTier: "strict" | "relaxed" = useRelaxed ? "relaxed" : "strict";
    const qual = await qualifyEntry(entryCtx, { demoRelaxed: useRelaxed });
    if (!qual.allow) {
      log.info("auto skipped (filter)", {
        mint: d.mint,
        reason: qual.reason,
        smartMoney: insider.smartMoneyCount,
        demo: tagDemo,
        tier: entryTier,
      });
      bumpTransient(d.mint, qual.reason.slice(0, 80));
      continue;
    }
    const agg = {
      confidence: qual.gateConfidence ?? 0.5,
      wallet: { confidence: qual.gateWalletConf ?? 0 },
      coin: { confidence: qual.gateCoinConf ?? 0 },
      timing: { confidence: qual.gateTimingConf ?? 0 },
    };
    const penalty = imitationPenaltyPct(sizeSol, v);
    // Real-mcap entry ceiling (launch/hybrid only): the gate scores bonding-curve
    // data, so a coin that has already graduated to a large DEX cap can slip through
    // as a "fresh launch". When MAX_ENTRY_MCAP_USD is set, skip those. Cached fetch,
    // reused by the entry-mcap stamp below.
    const maxEntryMcap = v2Mode ? 0 : env().MAX_ENTRY_MCAP_USD;
    if (maxEntryMcap > 0 && allowsLaunchTier()) {
      try {
        const coin = await fetchPumpFunCoin(d.mint);
        const rm = coin?.usdMarketCap ?? null;
        if (rm != null && rm > maxEntryMcap) {
          bumpTransient(
            d.mint,
            `mcap $${Math.round(rm / 1000)}k > ceiling $${Math.round(maxEntryMcap / 1000)}k`,
          );
          continue;
        }
      } catch {
        /* no pump data — allow (curve fallback) */
      }
    }
    if (session.mode === "paper") {
      if (tagDemo) {
        if (demoBalanceCache == null) {
          demoBalanceCache = (await fetchDemoAccount()).balanceSol;
        }
        if (sizeSol > demoBalanceCache + 1e-9) {
          skipInsufficientDemo.push(d.id);
          continue;
        }
      }
      // Single-truth: only paperOpen writes the paper ledger. Session and gate
      // metadata are captured in entry_features at insert time by the engine.
      const entryFeatures: Record<string, unknown> = {
        session_id: session.id,
        session_mode: "paper",
        auto: true,
        action: d.action,
        gateConfidence: agg.confidence,
        gateWalletConf: agg.wallet.confidence ?? qual.gateConfidence ?? 0,
        gateCoinConf: agg.coin.confidence ?? 0,
        gateTimingConf: agg.timing.confidence ?? 0,
        imitationPenalty: penalty,
        smartMoneyCount: insider.smartMoneyCount,
        insiderBoost: qual.insiderBoost,
        entry_tier: entryTier,
        // L0.2. NOTE: this is min(flowAge, decisionAge) and degrades to the
        // pending-queue wait for tokens older than the timing gate — it is a
        // blend, not pure reaction latency (see resolveTimingAgeSeconds).
        // `decision_to_intent_ms` below is the unambiguous queue-latency metric.
        entry_age_seconds: timingAge ?? null,
        // DexScreener 5m order-flow at entry — the momentum signal for DEX coins
        // (logged so the learner can mine which values actually precede winners).
        dexBuySellRatio: dexSnap?.buySellRatio ?? null,
        dexVolAcceleration: dexSnap?.volAcceleration ?? null,
        dexPriceChangeM5: dexSnap?.priceChangeM5 ?? null,
        dexBuysM5: dexSnap?.buysM5 ?? null,
        dexSellsM5: dexSnap?.sellsM5 ?? null,
        dexVolM5: dexSnap?.volM5 ?? null,
      };
      if (tagDemo) entryFeatures.ui_mode = "demo";

      // Single execution seam: TradeIntent → ExecutionPlan → ExecutionOutcome
      // (L3.5). The normalized outcome carries fill/slippage/latency for the
      // learner's execution-memory layer.
      const intent: TradeIntent = {
        intentId: `auto-${d.id}`,
        mint: d.mint,
        side: "buy",
        mode: "paper",
        sizeSol,
        reason: d.action,
        tier: entryTier,
        regime: getCurrentRegime().regime,
        createdAtMs: Date.now(),
      };
      // decision -> execution (T2 -> T3): how long the committed decision sat in
      // the pending queue before this tick picked it up and built an intent.
      // Combined with exec_latency_ms (intent -> fill) this closes the trade-side
      // half of the received/decoded/decision/execution chain.
      const decisionTsMs = Date.parse(d.ts);
      if (Number.isFinite(decisionTsMs)) {
        entryFeatures.decision_to_intent_ms = Math.max(0, intent.createdAtMs - decisionTsMs);
      }
      const plan = buildExecutionPlan(intent, {
        route: "paper",
        expectedPriceSol: v,
        maxSlippageBps: env().LIVE_SLIPPAGE_BPS,
        priorityFeeSol: 0,
        poolLiquiditySol: v,
      });
      // Pre-trade micro-sim (L3.6): paper logs what live would do (parity); a
      // live open would hard-reject here. Stamped for execution-memory analysis.
      const sim = microSimulate({
        sizeSol,
        poolLiquiditySol: v,
        maxSlippageBps: env().LIVE_SLIPPAGE_BPS,
        priorityFeeSol: 0,
      });
      entryFeatures.sim_expected_slippage_bps = sim.expectedSlippageBps;
      entryFeatures.sim_ok = sim.ok;
      if (!sim.ok) {
        log.info("micro-sim flagged (paper bypass)", { mint: d.mint, reason: sim.reason });
      }
      if (await haltedNow()) {
        log.warn("halt raised mid-tick — abandoning remaining entries", { mint: d.mint });
        break;
      }
      const { outcome, positionId } = await executePaperBuy(plan, {
        mint: d.mint,
        symbol: null,
        sizeSol,
        takeProfitPct: session.params.takeProfitPct ?? undefined,
        stopLossPct: session.params.stopLossPct ?? undefined,
        correlationId: `auto-${d.id}`,
        decisionId: d.id,
        entryFeatures,
        modulesAtEntry: (d.moduleScores ?? null) as Record<string, number> | null,
        meta: {
          decisionId: d.id.toString(),
          action: d.action,
          sessionId: session.id,
        },
      });
      if (outcome.status !== "filled" || positionId == null) {
        log.info("paper open rejected", {
          status: outcome.status, reason: outcome.rejectReason, mint: d.mint, sizeSol,
        });
        if (outcome.status === "rejected") skipInsufficientDemo.push(d.id);
        continue;
      }
      // Stamp normalized execution metrics for the learner's execution memory.
      await getDb()
        .execute(sql`
          UPDATE paper_positions
          SET entry_features = COALESCE(entry_features, '{}'::jsonb) || ${JSON.stringify(execMemoryFields(outcome))}::jsonb
          WHERE id = ${positionId}
        `)
        .catch(() => undefined);
      // Stamp the entry market cap. Prefer pump.fun's REAL usd_market_cap — accurate
      // for the mature/graduated coins we actually trade and the only correct value
      // post-graduation. Fall back to the bonding-curve estimate only for ultra-fresh
      // launches the API hasn't indexed yet (mcap null at t≈0). `v` = entry vSol.
      let entryMcapUsd: number | null = null;
      let entryMcapReal = false;
      try {
        const coin = await fetchPumpFunCoin(d.mint);
        if (coin?.usdMarketCap != null && Number.isFinite(coin.usdMarketCap) && coin.usdMarketCap > 0) {
          entryMcapUsd = coin.usdMarketCap;
          entryMcapReal = true;
        }
      } catch {
        /* fall back to the bonding-curve estimate */
      }
      if (entryMcapUsd == null) entryMcapUsd = mcapUsdFromVSol(v);
      if (entryMcapUsd != null && Number.isFinite(entryMcapUsd) && entryMcapUsd > 0) {
        await getDb()
          .execute(sql`
            UPDATE paper_positions
            SET entry_features = COALESCE(entry_features, '{}'::jsonb)
              || jsonb_build_object('entry_mcap_usd', ${entryMcapUsd}::float8,
                                    'entry_mcap_real', ${entryMcapReal}::boolean)
            WHERE id = ${positionId}
          `)
          .catch(() => undefined);
      }
      await accumulateStat(session.id, "tradesOpened", 1);
      opened++;
      heldMints.add(d.mint);
      if (tagDemo && demoBalanceCache != null) demoBalanceCache -= sizeSol;
      log.info("auto opened paper", {
        id: positionId.toString(), mint: d.mint, action: d.action, size: sizeSol,
        tier: entryTier, slipBps: outcome.slippageBpsRealized, latMs: outcome.latencyMs,
      });
      await notify({
        kind: "trade_open",
        title: `Auto opened ${d.mint.slice(0, 6)}…`,
        body: `${sizeSol} SOL · ${d.action}${qual.insiderBoost ? " · insider boost" : ""}`,
        mint: d.mint,
        extra: { sessionId: session.id },
      });
      continue;
    }

    // live mode — same gates as live-execution-listener (profile + confirm)
    const runtime = env();
    if (runtime.RUNTIME_PROFILE === "paper_safe") {
      await markSessionError("auto live blocked: RUNTIME_PROFILE=paper_safe");
      return {
        pendingCount: pendings.length,
        opened,
        topSkipReasons: ["runtime_paper_safe (auto live disabled)"],
        recentFilterSkips,
      };
    }
    if (!isLiveAllowed() && runtime.LIVE_DRY_RUN !== "on") {
      await markSessionError("auto live blocked: LIVE_CONFIRM / RUNTIME_PROFILE=live required");
      return {
        pendingCount: pendings.length,
        opened,
        topSkipReasons: ["live_not_confirmed"],
        recentFilterSkips,
      };
    }

    const kp = peekKeypair();
    const rpcs = rpcHttpUrls();
    if (!kp || rpcs.length === 0) {
      await markSessionError("wallet/rpc unavailable mid-tick");
      return {
        pendingCount: pendings.length,
        opened,
        topSkipReasons: [...transientSkips.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([reason, n]) => `${reason} (${n})`),
        recentFilterSkips,
      };
    }
    // Pre-trade micro-sim (L3.6): hard gate for live — never spend SOL into thin
    // depth / a slippage blowout / a gas spike.
    const liveSim = microSimulate({
      sizeSol,
      poolLiquiditySol: v,
      maxSlippageBps: runtime.LIVE_SLIPPAGE_BPS,
      priorityFeeSol: runtime.LIVE_PRIORITY_FEE_SOL,
      baselinePriorityFeeSol: runtime.LIVE_PRIORITY_FEE_SOL,
    });
    if (!liveSim.ok) {
      log.warn("micro-sim rejected live open", { mint: d.mint, reason: liveSim.reason, sizeSol });
      bumpTransient(d.mint, `micro-sim: ${liveSim.reason}`);
      continue;
    }
    const res = await executeLiveBuy({
      mint: d.mint,
      sizeSol,
      entryVSol: v,
      keypair: kp,
      rpcUrl: rpcs[0]!,
      modulesAtEntry: d.moduleScores,
      entryFeatures: {
        action: d.action,
        auto: true,
        session_id: session.id,
        decisionId: d.id.toString(),
        gateConfidence: agg.confidence,
        gateWalletConf: agg.wallet.confidence,
        gateCoinConf: agg.coin.confidence,
        gateTimingConf: agg.timing.confidence,
        imitationPenalty: penalty,
        entry_tier: entryTier,
      },
      decisionId: d.id,
    });
    if (res.ok) {
      // Stamp session_id on the freshly-opened live trade row
      if (res.tradeId != null) {
        await getDb().execute(sql`
          UPDATE live_trades
          SET session_id = ${session.id},
            entry_price = COALESCE(entry_price, ${v}::float),
            entry_features = COALESCE(entry_features, '{}'::jsonb)
              || jsonb_build_object('entry_v_sol', ${v}::float)
          WHERE id = ${res.tradeId}
        `);
      }
      // Shadow paper trade — opened in parallel for parity comparison so we can
      // tell after-the-fact whether live execution matched the model. Stored
      // in paper_positions with shadow_of=<live_id> in entry_features.
      try {
        const shadowFeatures: Record<string, unknown> = {
          session_id: session.id,
          session_mode: "live",
          auto: true,
          action: d.action,
          shadow_of: res.tradeId?.toString() ?? null,
          gateConfidence: agg.confidence,
          gateWalletConf: agg.wallet.confidence,
          gateCoinConf: agg.coin.confidence,
          gateTimingConf: agg.timing.confidence,
        };
        await paperOpen({
          mint: d.mint,
          symbol: null,
          sizeSol,
          takeProfitPct: session.params.takeProfitPct ?? undefined,
          stopLossPct: session.params.stopLossPct ?? undefined,
          correlationId: `shadow-${res.tradeId ?? d.id}`,
          decisionId: d.id,
          entryFeatures: shadowFeatures,
          modulesAtEntry: (d.moduleScores ?? null) as Record<string, number> | null,
          meta: { shadow_of: res.tradeId?.toString() ?? null, sessionId: session.id },
        }).catch((e) => {
          log.warn("shadow paper open failed", { mint: d.mint, err: String(e) });
        });
      } catch (e) {
        log.warn("shadow paper open failed", { mint: d.mint, err: String(e) });
      }
      await accumulateStat(session.id, "tradesOpened", 1);
      opened++;
      heldMints.add(d.mint);
      log.info("auto opened live", { mint: d.mint, dryRun: res.dryRun });
      await notify({
        kind: "trade_open",
        title: `Auto live open ${d.mint.slice(0, 6)}…`,
        body: `${sizeSol} SOL · ${d.action}${res.dryRun ? " (dry-run)" : ""}`,
        mint: d.mint,
        extra: { sessionId: session.id },
      });
    } else {
      log.warn("auto live buy failed", { mint: d.mint, reason: res.reason ?? res.error });
    }
  }

  if (skipAlreadyHeld.length) await markDecisionsSkipped(skipAlreadyHeld, "auto:already_open");
  if (skipFiltered.length) await markDecisionsSkipped(skipFiltered, "auto:strictness");
  if (skipNoPrice.length) await markDecisionsSkipped(skipNoPrice, "auto:no_v_sol");
  if (skipFilter.length) await markDecisionsSkipped(skipFilter, "auto:filter");
  if (skipRugLabel.length) await markDecisionsSkipped(skipRugLabel, "auto:rug_label");
  if (skipInsufficientDemo.length) {
    await markDecisionsSkipped(skipInsufficientDemo, "auto:insufficient_demo_balance");
  }

  const topSkipReasons = [...transientSkips.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([reason, n]) => `${reason} (${n})`);

  return {
    pendingCount: pendings.length,
    opened,
    topSkipReasons,
    recentFilterSkips,
  };
}

async function openCountForSession(session: AutoSessionDto): Promise<number> {
  if (session.mode === "paper") {
    const res = await getDb().execute(sql`
      SELECT COUNT(*)::int AS n
      FROM paper_positions
      WHERE state = 'OPEN'
        AND entry_features->>'session_id' = ${session.id}
    `);
    return ((res as unknown as { rows: Array<{ n: number }> }).rows[0]?.n) ?? 0;
  }
  const res = await getDb().execute(sql`
    SELECT COUNT(*)::int AS n
    FROM live_trades
    WHERE status = 'open' AND session_id = ${session.id}
  `);
  return ((res as unknown as { rows: Array<{ n: number }> }).rows[0]?.n) ?? 0;
}

async function fetchOpenMintsForSession(sessionId: string): Promise<Set<string>> {
  const res = await getDb().execute(sql`
    SELECT DISTINCT mint
    FROM paper_positions
    WHERE state = 'OPEN'
      AND entry_features->>'session_id' = ${sessionId}
    UNION
    SELECT DISTINCT mint
    FROM live_trades
    WHERE status = 'open' AND session_id = ${sessionId}
  `);
  const rows = (res as unknown as { rows: Array<{ mint: string }> }).rows;
  return new Set(rows.map((r) => r.mint));
}
