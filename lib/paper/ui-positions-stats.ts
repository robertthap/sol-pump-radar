import "server-only";

import { env } from "@/lib/env";
import { paperPnlSol } from "@/lib/paper/math";
import { riskBudgetFor } from "@/lib/risk/presets";
import { latestVSolBatch } from "@/lib/db/repos/events";
import type { UiPaperPositionRow } from "@/lib/paper/ui-positions";

export type UiPositionDto = {
  id: string;
  mint: string;
  symbol: string | null;
  sizeSol: number;
  entryVSol: number | null;
  exitVSol: number | null;
  pnlSol: number | null;
  pctOfSize: number | null;
  status: "open" | "closed";
  action: string | null;
};

export type UiPositionsStats = {
  startSol: number;
  realizedPnlSol: number;
  unrealizedPnlSol: number;
  totalPnlSol: number;
  equitySol: number;
  openSizeSol: number;
  availableSol: number;
  openCount: number;
  closedCount: number;
  wins: number;
  losses: number;
  winRate: number | null;
  bestPnl: number;
  worstPnl: number;
  preset: string;
  sizePerTrade: number;
  maxConcurrent: number;
  tpPct: number;
  slPct: number;
};

export async function enrichUiPaperPositions(rows: UiPaperPositionRow[]): Promise<{
  positions: UiPositionDto[];
  stats: UiPositionsStats;
}> {
  const budget = riskBudgetFor(env().RISK_PRESET);
  const openMints = rows.filter((p) => p.state === "OPEN").map((p) => p.mint);
  const latest = await latestVSolBatch(openMints);

  let unrealized = 0;
  let openSizeTotal = 0;
  let wins = 0;
  let losses = 0;
  let closedCount = 0;
  let realizedTotal = 0;
  let best = Number.NEGATIVE_INFINITY;
  let worst = Number.POSITIVE_INFINITY;

  const positions: UiPositionDto[] = rows.map((p) => {
    const base: UiPositionDto = {
      id: p.id,
      mint: p.mint,
      symbol: p.symbol,
      sizeSol: p.size_sol,
      entryVSol: p.entry_v_sol,
      exitVSol: p.exit_v_sol,
      pnlSol: p.realized_pnl_sol,
      pctOfSize: null,
      status: p.state === "OPEN" ? "open" : "closed",
      action: ((p.entry_features as Record<string, unknown> | null)?.action as string) ?? null,
    };
    if (base.status === "closed") {
      closedCount += 1;
      const r = base.pnlSol ?? 0;
      realizedTotal += r;
      if (r > 0) wins += 1;
      if (r < 0) losses += 1;
      best = Math.max(best, r);
      worst = Math.min(worst, r);
      return base;
    }
    if (p.entry_v_sol == null) return base;
    openSizeTotal += p.size_sol;
    const current = latest.get(p.mint);
    if (current == null) return { ...base, exitVSol: null };
    const { pnlSol, pctOfSize } = paperPnlSol({
      sizeSol: p.size_sol,
      entryVSol: p.entry_v_sol,
      currentVSol: current,
      pumpFeesPct: budget.pumpFeesPct,
      paperSlippagePct: budget.paperSlippagePct,
    });
    unrealized += pnlSol;
    return { ...base, exitVSol: current, pnlSol, pctOfSize };
  });

  const start = env().PAPER_START_SOL;
  const totalPnl = realizedTotal + unrealized;
  return {
    positions,
    stats: {
      startSol: start,
      realizedPnlSol: realizedTotal,
      unrealizedPnlSol: unrealized,
      totalPnlSol: totalPnl,
      equitySol: start + totalPnl,
      openSizeSol: openSizeTotal,
      availableSol: Math.max(0, start + realizedTotal - openSizeTotal),
      openCount: openMints.length,
      closedCount,
      wins,
      losses,
      winRate: closedCount > 0 ? wins / closedCount : null,
      bestPnl: Number.isFinite(best) ? best : 0,
      worstPnl: Number.isFinite(worst) ? worst : 0,
      preset: env().RISK_PRESET,
      sizePerTrade: budget.sizePerTradeSol,
      maxConcurrent: budget.maxConcurrent,
      tpPct: budget.tpPct,
      slPct: budget.slPct,
    },
  };
}
