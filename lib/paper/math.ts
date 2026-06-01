/**
 * Pure math helpers for paper PnL / exit logic.
 *
 * Web-safe (no DB, no signing, no executor side effects). Lives outside the
 * executor barrier so /api routes can compute display PnL without crossing
 * the worker boundary.
 */

import type { RiskBudget } from "@/lib/risk/presets";

export type ExitReason = "tp" | "sl" | "timeout" | "manual";

/**
 * Pump.fun bonding curve PnL approximation.
 *
 * Pump uses a constant-product virtual reserve curve. The price of one token
 * in SOL is v_sol / v_token, and v_sol * v_token = k. Since k is fixed during
 * the curve, the price scales as (v_sol / v_sol_initial)^2 in the small-
 * position limit. For a position of size_sol entered when v_sol = entry_v_sol
 * and now v_sol = current_v_sol, the gross value of the position scales by
 * (current_v_sol / entry_v_sol)^2.
 *
 * We additionally charge pump's 1% fee on each side and a small simulated
 * slippage on paper to avoid unrealistically optimistic backtests.
 */
export function paperPnlSol(opts: {
  sizeSol: number;
  entryVSol: number;
  currentVSol: number;
  pumpFeesPct: number;
  paperSlippagePct: number;
}): { pnlSol: number; ratio: number; pctOfSize: number } {
  if (
    !Number.isFinite(opts.entryVSol) ||
    opts.entryVSol <= 0 ||
    !Number.isFinite(opts.currentVSol)
  ) {
    return { pnlSol: 0, ratio: 1, pctOfSize: 0 };
  }
  const raw = (opts.currentVSol / opts.entryVSol) ** 2;
  const friction =
    (1 - opts.pumpFeesPct - opts.paperSlippagePct / 2) *
    (1 - opts.pumpFeesPct - opts.paperSlippagePct / 2);
  const effective = raw * friction;
  const pnlSol = opts.sizeSol * (effective - 1);
  return { pnlSol, ratio: effective, pctOfSize: effective - 1 };
}

export function shouldExit(opts: {
  pctOfSize: number;
  ageMs: number;
  budget: RiskBudget;
}): ExitReason | null {
  if (opts.pctOfSize >= opts.budget.tpPct) return "tp";
  if (opts.pctOfSize <= -opts.budget.slPct) return "sl";
  if (opts.ageMs >= opts.budget.maxHoldMinutes * 60_000) return "timeout";
  return null;
}
