import "server-only";
import { sql } from "drizzle-orm";
import { logger } from "@/lib/log";
import { env, rpcHttpUrls, activeMintWindowMinutes, autoDemoRelaxEnabled, isLiveAllowed } from "@/lib/env";
import { assertLiveExecutionAllowed } from "@/lib/runtime/live-guards";
import { readState } from "@/lib/circuit-breaker/state";
import { getDb } from "@/lib/db/client";
import {
  fetchPendingBuyDecisions,
  fetchTradableAutoFallback,
  markDecisionsSkipped,
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
import { paperPnlSol } from "@/lib/executor/paper";
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
import { latestVSolBatch } from "@/lib/db/repos/events";
import { VSOL_MODULE_KEY } from "@/lib/intelligence/scored-mint-adapter";
import { paperOpen, paperClose, paperPartialClose } from "@/lib/paper/engine";
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
    const isLaunch =
      (ms._engine_a ?? 0) >= 1 ||
      (ms.M1_GRADUATION ?? 0.5) < 0.35 ||
      d.action === "BUY_MODERATE";
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

  async function tick() {
    if (running) return;
    running = true;
    const t0 = Date.now();
    touchWorker("auto-trader");
    try {
      const session = await getActiveSession();
      if (!session) return;

      const cb = await readState();
      if (cb.state === "HALTED") {
        await stopSession("system halted");
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
      const maxConsec = session.mode === "live" ? env().LIVE_MAX_CONSECUTIVE_LOSSES : 5;
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
  const budget = riskBudgetFor(env().RISK_PRESET);

  if (session.mode === "paper") {
    // Single-truth: paper_positions is the only paper ledger. TP1 partial
    // closes go through paperPartialClose; final closes through paperClose.
    const res = await getDb().execute(sql`
      SELECT id::text AS id, mint, notional_sol::float8 AS size_sol,
        entry_price::float8 AS entry_v_sol, opened_at,
        modules_at_entry, entry_features,
        tp1_at_ts, tp1_realized_sol::float8 AS tp1_realized_sol,
        COALESCE(tp1_fraction, 0)::float8 AS tp1_fraction
      FROM paper_positions
      WHERE state = 'OPEN'
        AND entry_features->>'session_id' = ${session.id}
    `);
    type Raw = {
      id: string; mint: string; size_sol: number;
      entry_v_sol: number | null; opened_at: Date | string;
      modules_at_entry: Record<string, number> | null;
      entry_features: Record<string, unknown> | null;
      tp1_at_ts: Date | string | null;
      tp1_realized_sol: number;
      tp1_fraction: number;
    };
    const rows = (res as unknown as { rows: Raw[] }).rows;
    for (const pos of rows) {
      if (pos.entry_v_sol == null) continue;
      const current = await latestVSolFor(pos.mint);
      if (current == null) continue;
      const { pnlSol, pctOfSize } = paperPnlSol({
        sizeSol: pos.size_sol,
        entryVSol: pos.entry_v_sol,
        currentVSol: current,
        pumpFeesPct: budget.pumpFeesPct,
        paperSlippagePct: budget.paperSlippagePct,
      });
      const openedAt =
        pos.opened_at instanceof Date ? pos.opened_at.getTime() : new Date(pos.opened_at).getTime();
      const ageMs = Date.now() - openedAt;

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

      // ── TP1 partial via the new engine (no manual jsonb stamping) ──
      if (ladderOn && !tp1HitAt && pctOfSize >= tp1Pct) {
        const partial = await paperPartialClose({
          positionId: id,
          fraction: tp1Fraction,
          reason: "tp1",
          correlationId: `tp1-${id}`,
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

      // Trailing stop fires once armed (peak ≥ arm) and price falls trailStop
      // below the peak — after take-profit (full target) but before stop-loss.
      const exit = decidePaperExit(pctOfSize, peakPct, ageMs, {
        tpPct,
        slPct,
        maxHoldMs,
        trailArmPct: trailingEnabled ? trailArmPct : 0,
        trailStopPct: trailingEnabled ? trailStopPct : 0,
      });
      if (!exit) continue;

      const reason = tp1HitAt ? `${exit}+tp1` : exit;
      const closed = await paperClose({
        positionId: id,
        reason,
        correlationId: `close-${id}`,
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
      await accumulateStat(session.id, win ? "wins" : "losses", 1);
      await accumulateStat(session.id, "tradesClosed", 1);
      await accumulateStat(session.id, "realizedPnlSol", finalPnl);
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
    const grossPct = (current - entryV) / entryV;
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

  // Capacity check
  const openCount = await openCountForSession(session);
  const remaining = Math.max(0, session.params.maxConcurrent - openCount);
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
    const insider = await analyzeMintInsiders(d.mint);
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
        // L0.2: token age (seconds) at entry — our reaction time. Lower = faster.
        entry_age_seconds: timingAge ?? null,
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
