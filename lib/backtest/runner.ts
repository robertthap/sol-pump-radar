import "server-only";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { paperPnlSol } from "@/lib/executor/paper";
import { passesConfluence, passesModuleVetoes } from "@/lib/trade/entry-filter";
import { imitationPenaltyPct } from "@/lib/intel/imitation";
import {
  walletGate,
  coinGate,
  timingGate,
  aggregateGates,
  type GateResult,
} from "@/lib/intel/three-gate";

/**
 * Lightweight backtest harness.
 *
 * Replays historical decisions and simulates paper-trade outcomes against
 * the actual subsequent events for each mint. Lets the user explore "what
 * if I changed thresholds / TP / SL / vetoes?" without running a live
 * shadow strategy.
 *
 * Inputs:
 *   - windowHours: how far back to replay (max 7 days)
 *   - sizeSol, takeProfitPct, stopLossPct, maxHoldMinutes
 *   - actionFilter: which decision actions to enter on (BUY_STRONG/MODERATE)
 *   - enableBotVetoes: drop mints with hasBundle / mechanicalUptrend
 *   - enableRingVetoes: drop mints with bundle ring exposure ≥ 2
 *
 * Outputs:
 *   - per-trade results
 *   - aggregate PnL, win rate, expectancy, avg hold, by-action stats
 */

export type BacktestParams = {
  windowHours: number;
  sizeSol: number;
  takeProfitPct: number;
  stopLossPct: number;
  maxHoldMinutes: number;
  actionFilter: ("BUY_STRONG" | "BUY_MODERATE")[];
  enableBotVetoes: boolean;
  enableRingVetoes: boolean;
  /** Skip mints labelled rugged/stalled in rug_labels (Kalacheva §4.2). */
  enableRugLabelVeto?: boolean;
  /** Apply confluence + module vetoes aligned with live auto-trader (not full 3-gate). */
  enableEntryFilter?: boolean;
  /** Approximate live three-gate + edge check using historical scores (wallet gate uses M2 proxy). */
  enableThreeGate?: boolean;
  /** Only BUY_STRONG when strict (matches auto-trader balanced preset). */
  strongOnly?: boolean;
  pumpFeesPct?: number;
  paperSlippagePct?: number;
  maxTrades?: number;
  /** TP1 partial exit threshold (Kalacheva 2026 §6.3). Set 0 to disable. */
  tp1Pct?: number;
  /** Fraction of position sold at TP1 (e.g., 0.5 = sell half). */
  tp1Fraction?: number;
};

export type BacktestTrade = {
  mint: string;
  decisionId: string;
  action: string;
  enteredAt: string;
  entryVSol: number;
  exitedAt: string | null;
  exitVSol: number | null;
  exitReason: "tp" | "sl" | "timeout" | "no_exit_data" | "tp+tp1" | "sl+tp1" | "timeout+tp1";
  pnlSol: number;
  pctOfSize: number;
  holdSeconds: number;
  tp1Hit: boolean;
  tp1RealizedSol: number;
};

export type BacktestSummary = {
  params: BacktestParams;
  trades: BacktestTrade[];
  filtered: { reason: string; count: number }[];
  overall: {
    candidates: number;
    entered: number;
    closed: number;
    winRate: number;
    totalPnlSol: number;
    avgPnlSol: number;
    avgWinSol: number;
    avgLossSol: number;
    expectancySol: number;
    avgHoldSeconds: number;
    bestPnlSol: number;
    worstPnlSol: number;
    tp1HitCount: number;
    tp1HitRate: number;
    tp1TotalRealizedSol: number;
  };
  byAction: { action: string; n: number; winRate: number; totalPnlSol: number }[];
  byExitReason: { exitReason: string; n: number; totalPnlSol: number }[];
  durationMs: number;
};

function approximateWalletGate(insiderScore: number): GateResult {
  if (insiderScore >= 0.58) {
    return { pass: false, confidence: 0, reasons: [`insider concentration ${insiderScore.toFixed(2)}`] };
  }
  const conf = Math.max(0.2, Math.min(0.85, 0.65 - insiderScore));
  const pass = insiderScore < 0.5 && conf >= 0.35;
  return { pass, confidence: conf, reasons: [`M2 insider proxy ${insiderScore.toFixed(2)}`] };
}

function passesThreeGateBacktest(input: {
  ms: Record<string, number>;
  flags: { hasBundle: boolean; hasSniper: boolean; mechanicalUptrend: boolean } | undefined;
  ageSeconds: number | null;
  vSol: number;
  sizeSol: number;
  takeProfitPct: number;
}): { allow: boolean; reason: string } {
  const wallet = approximateWalletGate(input.ms.M2_INSIDER ?? 0);
  const coin = coinGate({
    flags: input.flags
      ? {
          mint: "",
          hasBundle: input.flags.hasBundle,
          hasSniper: input.flags.hasSniper,
          mechanicalUptrend: input.flags.mechanicalUptrend,
          hasBumpBot: false,
          bundleWalletCount: 0,
          sniperWalletCount: 0,
          bumpWalletCount: 0,
          earlyUniqueBuyers: 0,
          creator: null,
        }
      : null,
    gradScore: input.ms.M1_GRADUATION ?? 0.5,
    rugScore: input.ms.M3_RUG ?? 0,
    curveVelocity5m: null,
    buys5m: null,
    sells5m: null,
    buyVol5m: null,
    sellVol5m: null,
    uniqueBuyers5m: null,
  });
  const timing = timingGate({
    ageSeconds: input.ageSeconds,
    vSol: input.vSol,
    sizeSol: input.sizeSol,
  });
  const weights = { wallet: 0.4, coin: 0.4, timing: 0.2 };
  const agg = aggregateGates({ wallet, coin, timing, weights });
  const penalty = imitationPenaltyPct(input.sizeSol, input.vSol);
  const expectedEdge = input.takeProfitPct * agg.confidence - penalty;
  const minEdge = 0.03;
  if (!agg.pass || expectedEdge < minEdge) {
    return {
      allow: false,
      reason: agg.reasons.join(" | ") || `edge ${expectedEdge.toFixed(3)} < ${minEdge}`,
    };
  }
  return { allow: true, reason: "three-gate pass" };
}

export async function runBacktest(params: BacktestParams): Promise<BacktestSummary> {
  const t0 = Date.now();
  const fees = params.pumpFeesPct ?? 0.01;
  const slip = params.paperSlippagePct ?? 0.005;
  const maxTrades = params.maxTrades ?? 500;
  const filtered: Map<string, number> = new Map();
  const incFilter = (k: string) => filtered.set(k, (filtered.get(k) ?? 0) + 1);

  // Pull candidate decisions: BUY_* in the window, with v_sol available at the
  // time of the decision.
  const interval = `${Math.min(params.windowHours, 24 * 7)} hours`;
  const r = await getDb().execute(sql`
    WITH cand AS (
      SELECT
        d.id::text AS id,
        d.mint::text AS mint,
        d.action::text AS action,
        d.ts AS ts,
        d.confluence_score::float8 AS confluence_score,
        d.module_scores AS module_scores,
        EXTRACT(EPOCH FROM (d.ts - t.created_at))::float8 AS age_seconds
      FROM decision_log d
      JOIN tokens t ON t.mint = d.mint
      WHERE d.action IN ('BUY_STRONG','BUY_MODERATE')
        AND d.ts > now() - ${sql.raw(`'${interval}'::interval`)}
      ORDER BY d.ts ASC
    )
    SELECT c.id, c.mint, c.action, c.ts, c.confluence_score, c.module_scores, c.age_seconds,
      (
        SELECT v_sol_after::float8
        FROM events e
        WHERE e.mint = c.mint
          AND e.v_sol_after IS NOT NULL
          AND e.ts <= c.ts
        ORDER BY e.ts DESC
        LIMIT 1
      ) AS entry_v_sol
    FROM cand c
    LIMIT ${sql.raw(String(maxTrades * 4))}
  `);
  type CandRow = {
    id: string;
    mint: string;
    action: string;
    ts: Date | string;
    entry_v_sol: number | null;
    confluence_score: number;
    module_scores: Record<string, number> | null;
    age_seconds: number | null;
  };
  const cands = (r as unknown as { rows: CandRow[] }).rows;

  // Veto data — bot flags + ring exposures (cheap, two lookups for the whole
  // candidate set).
  let flagsByMint = new Map<string, { hasBundle: boolean; hasSniper: boolean; mechanicalUptrend: boolean }>();
  let ringsByMint = new Map<string, { bundleRingBuyers: number; sniperRingBuyers: number }>();
  let rugsByMint = new Map<string, string>();
  if ((params.enableBotVetoes || params.enableThreeGate) && cands.length > 0) {
    const fl = await getDb().execute(sql`
      SELECT mint::text AS mint, has_bundle, has_sniper, mechanical_uptrend
      FROM mint_bot_flags
      WHERE mint = ANY(${sql.raw(`ARRAY[${cands.map((c) => `'${c.mint.replace(/'/g, "''")}'`).join(",")}]`)})
    `);
    type Raw = { mint: string; has_bundle: boolean; has_sniper: boolean; mechanical_uptrend: boolean };
    flagsByMint = new Map(
      (fl as unknown as { rows: Raw[] }).rows.map((row) => [
        row.mint,
        {
          hasBundle: !!row.has_bundle,
          hasSniper: !!row.has_sniper,
          mechanicalUptrend: !!row.mechanical_uptrend,
        },
      ]),
    );
  }
  if (params.enableRugLabelVeto !== false && cands.length > 0) {
    const rg = await getDb().execute(sql`
      SELECT mint::text AS mint, label::text AS label
      FROM rug_labels
      WHERE mint = ANY(${sql.raw(`ARRAY[${cands.map((c) => `'${c.mint.replace(/'/g, "''")}'`).join(",")}]`)})
        AND label IN ('rugged', 'stalled')
    `);
    type RawRug = { mint: string; label: string };
    rugsByMint = new Map(
      (rg as unknown as { rows: RawRug[] }).rows.map((row) => [row.mint, row.label]),
    );
  }
  if (params.enableRingVetoes && cands.length > 0) {
    const rg = await getDb().execute(sql`
      WITH recent_buyers AS (
        SELECT DISTINCT mint::text AS mint, wallet
        FROM events
        WHERE mint = ANY(${sql.raw(`ARRAY[${cands.map((c) => `'${c.mint.replace(/'/g, "''")}'`).join(",")}]`)})
          AND kind = 'buy' AND wallet IS NOT NULL
          AND ts > now() - ${sql.raw(`'${interval}'::interval`)}
      )
      SELECT
        rb.mint,
        COUNT(*) FILTER (WHERE c.kind = 'bundle_ring')::int AS bundle_ring_buyers,
        COUNT(*) FILTER (WHERE c.kind = 'sniper_ring')::int AS sniper_ring_buyers
      FROM recent_buyers rb
      JOIN cluster_members cm ON cm.wallet = rb.wallet
      JOIN clusters c ON c.id = cm.cluster_id
      GROUP BY rb.mint
    `);
    type Raw = { mint: string; bundle_ring_buyers: number; sniper_ring_buyers: number };
    ringsByMint = new Map(
      (rg as unknown as { rows: Raw[] }).rows.map((row) => [
        row.mint,
        { bundleRingBuyers: row.bundle_ring_buyers, sniperRingBuyers: row.sniper_ring_buyers },
      ]),
    );
  }

  const trades: BacktestTrade[] = [];
  let entered = 0;
  // Track open positions per-mint to avoid stacking (matches live behaviour)
  const openMints = new Set<string>();

  for (const c of cands) {
    if (entered >= maxTrades) break;
    if (!params.actionFilter.includes(c.action as "BUY_STRONG" | "BUY_MODERATE")) {
      incFilter("action_filter");
      continue;
    }
    if (params.strongOnly && c.action !== "BUY_STRONG") {
      incFilter("strong_only");
      continue;
    }
    if (params.enableEntryFilter) {
      const ms = (c.module_scores ?? {}) as Record<string, number>;
      const conf = passesConfluence({
        mint: c.mint,
        action: c.action,
        confluenceScore: c.confluence_score ?? 0,
        moduleScores: ms,
        vSol: c.entry_v_sol,
        sizeSol: params.sizeSol,
      });
      if (!conf.allow) {
        incFilter("confluence_filter");
        continue;
      }
      const mods = passesModuleVetoes({
        mint: c.mint,
        action: c.action,
        confluenceScore: c.confluence_score ?? 0,
        moduleScores: ms,
        vSol: c.entry_v_sol,
        sizeSol: params.sizeSol,
      });
      if (!mods.allow) {
        incFilter("module_veto");
        continue;
      }
    }
    if (params.enableThreeGate) {
      const ms = (c.module_scores ?? {}) as Record<string, number>;
      const gate = passesThreeGateBacktest({
        ms,
        flags: flagsByMint.get(c.mint),
        ageSeconds: c.age_seconds,
        vSol: c.entry_v_sol ?? 0,
        sizeSol: params.sizeSol,
        takeProfitPct: params.takeProfitPct,
      });
      if (!gate.allow) {
        incFilter("three_gate");
        continue;
      }
    }
    if (c.entry_v_sol == null || c.entry_v_sol <= 0) {
      incFilter("missing_entry_vsol");
      continue;
    }
    if (openMints.has(c.mint)) {
      incFilter("already_open");
      continue;
    }
    if (params.enableBotVetoes) {
      const f = flagsByMint.get(c.mint);
      if (f?.hasBundle) { incFilter("bundle_bot"); continue; }
      if (f?.mechanicalUptrend) { incFilter("mechanical_uptrend"); continue; }
    }
    if (params.enableRingVetoes) {
      const rings = ringsByMint.get(c.mint);
      if (rings && rings.bundleRingBuyers >= 2) { incFilter("bundle_ring"); continue; }
    }
    if (params.enableRugLabelVeto !== false) {
      const rug = rugsByMint.get(c.mint);
      if (rug === "rugged") { incFilter("rug_label_rugged"); continue; }
      if (rug === "stalled") { incFilter("rug_label_stalled"); continue; }
    }

    // Walk forward through events post-entry to find exit.
    const enteredTs = c.ts instanceof Date ? c.ts.getTime() : new Date(c.ts).getTime();
    const tpHorizon = enteredTs + params.maxHoldMinutes * 60_000;
    const ev = await getDb().execute(sql`
      SELECT ts, v_sol_after::float8 AS v
      FROM events
      WHERE mint = ${c.mint}
        AND v_sol_after IS NOT NULL
        AND ts > ${new Date(enteredTs).toISOString()}::timestamptz
        AND ts <= ${new Date(tpHorizon).toISOString()}::timestamptz
      ORDER BY ts ASC
      LIMIT 5000
    `);
    type Tick = { ts: Date | string; v: number };
    const ticks = (ev as unknown as { rows: Tick[] }).rows;

    // Multi-tier ladder (Kalacheva 2026 §6.3): when configured, the first
    // pass through the ticks fires TP1 partial exit, then continues looking
    // for TP2 / SL / timeout on the residual.
    const tp1Pct = params.tp1Pct ?? 0;
    const tp1Fraction = Math.max(0, Math.min(0.95, params.tp1Fraction ?? 0));
    const ladderOn = tp1Pct > 0 && tp1Fraction > 0 && tp1Pct < params.takeProfitPct;

    let exitTs: number | null = null;
    let exitV: number | null = null;
    let exitReason: BacktestTrade["exitReason"] = "no_exit_data";
    let pnlAtExit = 0;
    let pctAtExit = 0;
    let tp1Hit = false;
    let tp1Realized = 0;
    for (const t of ticks) {
      const tts = t.ts instanceof Date ? t.ts.getTime() : new Date(t.ts).getTime();
      const { pctOfSize, pnlSol } = paperPnlSol({
        sizeSol: params.sizeSol,
        entryVSol: c.entry_v_sol!,
        currentVSol: t.v,
        pumpFeesPct: fees,
        paperSlippagePct: slip,
      });
      // TP1 partial — lock in the realised portion and keep looping.
      if (ladderOn && !tp1Hit && pctOfSize >= tp1Pct) {
        tp1Hit = true;
        tp1Realized = pnlSol * tp1Fraction;
      }
      if (pctOfSize >= params.takeProfitPct) {
        exitReason = tp1Hit ? "tp+tp1" : "tp";
        exitTs = tts;
        exitV = t.v;
        pnlAtExit = pnlSol;
        pctAtExit = pctOfSize;
        break;
      }
      if (pctOfSize <= -params.stopLossPct) {
        exitReason = tp1Hit ? "sl+tp1" : "sl";
        exitTs = tts;
        exitV = t.v;
        pnlAtExit = pnlSol;
        pctAtExit = pctOfSize;
        break;
      }
      pnlAtExit = pnlSol;
      pctAtExit = pctOfSize;
      exitTs = tts;
      exitV = t.v;
    }
    if (exitReason === "no_exit_data" && exitTs != null) {
      exitReason = tp1Hit ? "timeout+tp1" : "timeout";
    }

    // Settle PnL: TP1 portion is locked, residual realised at exit price.
    const residualFraction = tp1Hit ? 1 - tp1Fraction : 1;
    const finalPnl = tp1Realized + pnlAtExit * residualFraction;

    entered++;
    openMints.add(c.mint);
    trades.push({
      mint: c.mint,
      decisionId: c.id,
      action: c.action,
      enteredAt: new Date(enteredTs).toISOString(),
      entryVSol: c.entry_v_sol,
      exitedAt: exitTs ? new Date(exitTs).toISOString() : null,
      exitVSol: exitV,
      exitReason,
      pnlSol: Number.isFinite(finalPnl) ? finalPnl : 0,
      pctOfSize: Number.isFinite(pctAtExit) ? pctAtExit : 0,
      holdSeconds: exitTs ? Math.round((exitTs - enteredTs) / 1000) : 0,
      tp1Hit,
      tp1RealizedSol: Number.isFinite(tp1Realized) ? tp1Realized : 0,
    });
  }

  const closed = trades.filter((t) => t.exitReason !== "no_exit_data");
  const wins = closed.filter((t) => t.pnlSol > 0);
  const losses = closed.filter((t) => t.pnlSol <= 0);
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const avg = (xs: number[]) => (xs.length === 0 ? 0 : sum(xs) / xs.length);

  const tp1Trades = closed.filter((t) => t.tp1Hit);
  const overall = {
    candidates: cands.length,
    entered: trades.length,
    closed: closed.length,
    winRate: closed.length === 0 ? 0 : wins.length / closed.length,
    totalPnlSol: sum(closed.map((t) => t.pnlSol)),
    avgPnlSol: avg(closed.map((t) => t.pnlSol)),
    avgWinSol: avg(wins.map((t) => t.pnlSol)),
    avgLossSol: avg(losses.map((t) => t.pnlSol)),
    expectancySol: avg(closed.map((t) => t.pnlSol)),
    avgHoldSeconds: avg(closed.map((t) => t.holdSeconds)),
    bestPnlSol: closed.length === 0 ? 0 : Math.max(...closed.map((t) => t.pnlSol)),
    worstPnlSol: closed.length === 0 ? 0 : Math.min(...closed.map((t) => t.pnlSol)),
    tp1HitCount: tp1Trades.length,
    tp1HitRate: closed.length === 0 ? 0 : tp1Trades.length / closed.length,
    tp1TotalRealizedSol: sum(tp1Trades.map((t) => t.tp1RealizedSol)),
  };

  const byActionMap = new Map<string, { n: number; wins: number; pnl: number }>();
  for (const t of closed) {
    const e = byActionMap.get(t.action) ?? { n: 0, wins: 0, pnl: 0 };
    e.n++;
    if (t.pnlSol > 0) e.wins++;
    e.pnl += t.pnlSol;
    byActionMap.set(t.action, e);
  }
  const byAction = [...byActionMap.entries()].map(([action, v]) => ({
    action,
    n: v.n,
    winRate: v.n === 0 ? 0 : v.wins / v.n,
    totalPnlSol: v.pnl,
  }));

  const byExitMap = new Map<string, { n: number; pnl: number }>();
  for (const t of closed) {
    const e = byExitMap.get(t.exitReason) ?? { n: 0, pnl: 0 };
    e.n++;
    e.pnl += t.pnlSol;
    byExitMap.set(t.exitReason, e);
  }
  const byExitReason = [...byExitMap.entries()].map(([exitReason, v]) => ({
    exitReason,
    n: v.n,
    totalPnlSol: v.pnl,
  }));

  return {
    params,
    trades,
    filtered: [...filtered.entries()].map(([reason, count]) => ({ reason, count })),
    overall,
    byAction,
    byExitReason,
    durationMs: Date.now() - t0,
  };
}
