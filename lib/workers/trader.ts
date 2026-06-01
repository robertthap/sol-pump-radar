import "server-only";
import { eq } from "drizzle-orm";
import { logger } from "@/lib/log";
import { env, rpcHttpUrls, isLiveAllowed } from "@/lib/env";
import { readState } from "@/lib/circuit-breaker/state";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { decisionLog } from "@/lib/db/schema";
import { riskBudgetFor } from "@/lib/risk/presets";
import { paperPnlSol, shouldExit } from "@/lib/executor/paper";
import {
  closePaperPosition,
  fetchOpenMints,
  fetchOpenPositions,
  fetchPendingBuyDecisions,
  markDecisionsSkipped,
  openPaperPosition,
} from "@/lib/db/repos/paper-trades";
import { recordOutcome } from "@/lib/db/repos/outcomes";
import { executeLiveBuy } from "@/lib/executor/live";
import { peekKeypair } from "@/lib/wallet/session";
import { getEffectiveTradeLimits } from "@/lib/db/repos/settings";
import { getActiveSession } from "@/lib/db/repos/auto-sessions";
import { fetchMintFlags } from "@/lib/db/repos/bots";
import { analyzeMintInsiders } from "@/lib/intel/insider-tracker";
import { qualifyEntry } from "@/lib/trade/entry-filter";

const log = logger("trader");
const TICK_MS = 2_000;

async function latestVSolFor(mint: string): Promise<number | null> {
  const res = await getDb().execute(sql`
    SELECT v_sol_after::float8 AS v
    FROM events
    WHERE mint = ${mint} AND v_sol_after IS NOT NULL
    ORDER BY ts DESC
    LIMIT 1
  `);
  const row = (res as unknown as { rows: Array<{ v: number | null }> }).rows[0];
  return row?.v ?? null;
}

async function fetchMintFlow(mint: string) {
  const res = await getDb().execute(sql`
    SELECT
      COUNT(*) FILTER (WHERE kind = 'buy' AND ts > now() - interval '5 minutes')::int AS buys_5m,
      COUNT(*) FILTER (WHERE kind = 'sell' AND ts > now() - interval '5 minutes')::int AS sells_5m,
      COUNT(DISTINCT wallet) FILTER (WHERE kind = 'buy' AND ts > now() - interval '5 minutes')::int AS unique_buyers_5m,
      EXTRACT(EPOCH FROM (now() - t.created_at))::float8 AS age_seconds
    FROM events e
    LEFT JOIN tokens t ON t.mint = e.mint
    WHERE e.mint = ${mint} AND e.ts > now() - interval '15 minutes'
    GROUP BY t.created_at
  `);
  const r = (res as unknown as {
    rows: Array<{ buys_5m: number; sells_5m: number; unique_buyers_5m: number; age_seconds: number | null }>;
  }).rows[0];
  return {
    buys5m: r?.buys_5m ?? 0,
    sells5m: r?.sells_5m ?? 0,
    uniqueBuyers5m: r?.unique_buyers_5m ?? 0,
    buyVol5m: null,
    sellVol5m: null,
    curveVelocity5m: null,
    ageSeconds: r?.age_seconds ?? null,
  };
}

export async function startTrader() {
  const mode = env().TRADER_MODE;
  log.info("trader starting", {
    mode,
    preset: env().RISK_PRESET,
    tickMs: TICK_MS,
    liveExecution: env().LIVE_EXECUTION,
    liveDryRun: env().LIVE_DRY_RUN,
  });
  const budget = riskBudgetFor(env().RISK_PRESET);
  let running = false;

  async function maybeRouteLive(opts: {
    decisionId: bigint;
    mint: string;
    sizeSol: number;
    entryVSol: number;
    moduleScores: Record<string, number>;
    action: string;
  }): Promise<{ routed: boolean; ok: boolean; reason?: string }> {
    const e = env();
    if (e.LIVE_EXECUTION !== "on" || e.TRADER_MODE !== "live") return { routed: false, ok: false };
    if (e.RUNTIME_PROFILE === "paper_safe") {
      return { routed: false, ok: false, reason: "runtime_paper_safe" };
    }
    if (!isLiveAllowed() && e.LIVE_DRY_RUN !== "on") {
      return { routed: false, ok: false, reason: "live_not_confirmed" };
    }
    const kp = peekKeypair();
    if (!kp) return { routed: false, ok: false, reason: "wallet_locked" };
    const rpcs = rpcHttpUrls();
    const rpcUrl = rpcs[0];
    if (!rpcUrl) return { routed: false, ok: false, reason: "no_rpc" };

    // Clamp to effective per-trade cap (DB override or env default).
    const limits = await getEffectiveTradeLimits();
    const sizeSol = Math.min(opts.sizeSol, limits.liveMaxPerTradeSol);
    const res = await executeLiveBuy({
      mint: opts.mint,
      sizeSol,
      entryVSol: opts.entryVSol,
      keypair: kp,
      rpcUrl,
      modulesAtEntry: opts.moduleScores,
      entryFeatures: { action: opts.action, decisionId: opts.decisionId.toString() },
      decisionId: opts.decisionId,
    });
    if (res.ok) {
      const tag = res.dryRun ? "executed_live_dryrun" : "executed_live";
      const reasonStr =
        (res.simulatedSignature ?? res.signature ?? `live_trade=${res.tradeId?.toString() ?? "?"}`)
          .toString()
          .slice(0, 120);
      await getDb()
        .update(decisionLog)
        .set({ executed: tag, executorReason: reasonStr })
        .where(eq(decisionLog.id, opts.decisionId));
      return { routed: true, ok: true };
    }
    await getDb()
      .update(decisionLog)
      .set({
        executed: "live_failed",
        executorReason: (res.error ?? res.reason ?? "unknown").slice(0, 120),
      })
      .where(eq(decisionLog.id, opts.decisionId));
    return { routed: true, ok: false, reason: res.error ?? res.reason };
  }

  async function tick() {
    if (running) return;
    running = true;
    try {
      const cb = await readState();
      if (cb.state === "HALTED" || cb.state === "PAUSED") {
        return;
      }

      const openPositions = await fetchOpenPositions();
      for (const pos of openPositions) {
        if (pos.entryVSol == null) continue;
        const current = await latestVSolFor(pos.mint);
        if (current == null) continue;
        const { pnlSol, pctOfSize } = paperPnlSol({
          sizeSol: pos.sizeSol,
          entryVSol: pos.entryVSol,
          currentVSol: current,
          pumpFeesPct: budget.pumpFeesPct,
          paperSlippagePct: budget.paperSlippagePct,
        });
        const ageMs = Date.now() - pos.openedAt.getTime();
        const exit = shouldExit({ pctOfSize, ageMs, budget });
        if (exit) {
          await closePaperPosition({
            id: pos.id,
            exitVSol: current,
            pnlSol,
            feesSol: pos.sizeSol * budget.pumpFeesPct * 2,
            reason: exit,
          });
          await recordOutcome({
            source: "paper",
            tradeId: pos.id,
            entryVSol: pos.entryVSol,
            exitVSol: current,
            pnlSol,
            pctOfSize,
            exitReason: exit,
            holdSeconds: ageMs / 1000,
            action: pos.action,
            modulesAtEntry: pos.modulesAtEntry,
          });
          log.info("closed paper position", {
            id: pos.id.toString(),
            mint: pos.mint,
            reason: exit,
            pnlSol: pnlSol.toFixed(4),
            pct: (pctOfSize * 100).toFixed(1) + "%",
          });
        }
      }

      const pendings = await fetchPendingBuyDecisions(90);
      if (pendings.length === 0) return;

      const autoActive = await getActiveSession();
      if (autoActive) {
        // Auto-trader owns pending buy decisions while a session is active.
        return;
      }

      const heldMints = await fetchOpenMints();
      const openCount = heldMints.size;
      let remaining = Math.max(0, budget.maxConcurrent - openCount);
      const limits = await getEffectiveTradeLimits();
      const paperSize = limits.paperSizePerTradeSol;

      const skipAlreadyHeld: bigint[] = [];
      const skipMaxConcurrent: bigint[] = [];
      const skipNoPrice: bigint[] = [];
      const skipFiltered: bigint[] = [];

      for (const d of pendings) {
        if (heldMints.has(d.mint)) {
          skipAlreadyHeld.push(d.id);
          continue;
        }
        if (remaining <= 0) {
          skipMaxConcurrent.push(d.id);
          continue;
        }
        if (d.action !== "BUY_STRONG") {
          skipFiltered.push(d.id);
          continue;
        }
        const v = await latestVSolFor(d.mint);
        if (v == null || v <= 0) {
          skipNoPrice.push(d.id);
          continue;
        }

        const flags = await fetchMintFlags(d.mint);
        if (flags?.hasBundle || flags?.mechanicalUptrend) {
          skipFiltered.push(d.id);
          continue;
        }
        const flowData = await fetchMintFlow(d.mint);
        const insider = await analyzeMintInsiders(d.mint);
        const qual = await qualifyEntry({
          mint: d.mint,
          action: d.action,
          confluenceScore: d.confluenceScore ?? 0,
          moduleScores: d.moduleScores as Record<string, number> | null,
          vSol: v,
          sizeSol: paperSize,
          ageSeconds: flowData.ageSeconds,
          flow: flowData,
          flags,
          insider,
          takeProfitPct: budget.tpPct,
        });
        if (!qual.allow) {
          skipFiltered.push(d.id);
          continue;
        }

        const opened = await openPaperPosition({
          mint: d.mint,
          sizeSol: paperSize,
          entryVSol: v,
          action: d.action,
          modulesAtEntry: d.moduleScores,
          decisionId: d.id,
        });
        if (opened != null) {
          heldMints.add(d.mint);
          remaining--;
          log.info("opened paper position", {
            id: opened.toString(),
            mint: d.mint,
            sizeSol: paperSize,
            entryVSol: v.toFixed(2),
            action: d.action,
          });
        }

        const live = await maybeRouteLive({
          decisionId: d.id,
          mint: d.mint,
          sizeSol: paperSize,
          entryVSol: v,
          moduleScores: d.moduleScores,
          action: d.action,
        });
        if (live.routed) {
          log.info("live route attempt", {
            mint: d.mint,
            ok: live.ok,
            reason: live.reason ?? null,
          });
        }
      }
      if (skipAlreadyHeld.length) await markDecisionsSkipped(skipAlreadyHeld, "already_open");
      if (skipMaxConcurrent.length) await markDecisionsSkipped(skipMaxConcurrent, "max_concurrent");
      if (skipNoPrice.length) await markDecisionsSkipped(skipNoPrice, "no_v_sol");
      if (skipFiltered.length) await markDecisionsSkipped(skipFiltered, "entry_filter");
    } catch (e) {
      log.error("tick failed", { err: String(e) });
    } finally {
      running = false;
    }
  }

  const interval = setInterval(() => {
    tick().catch((e) => log.error("tick rejected", { err: String(e) }));
  }, TICK_MS);
  setTimeout(() => tick().catch(() => undefined), 3_000);

  return () => clearInterval(interval);
}
