/**
 * 3-layer causal PnL attribution (PURE — no server-only, testable). L5.1.
 *
 * Decomposes a closed trade's realized PnL into three causal layers so the
 * learner never mis-blames one for another (the principal-engineer note:
 * "don't blame strategy for execution failure"):
 *
 *   - execution (L2): cost of entry slippage vs the expected fill — always a drag.
 *   - market    (L3): loss caused by a rug / adverse market move we entered into.
 *   - edge      (L1): the residual — what the *strategy* actually earned/lost.
 *
 * Identity: edgeSol + executionSol + marketSol === pnlSol (modulo float).
 *
 * Heuristic but defensible: a rug-driven loss is attributed to market (edge≈0,
 * so the strategy isn't penalized for a rug it couldn't have priced), while a
 * non-rug loss stays on edge (the strategy owns it).
 */

export type TradeAttributionInput = {
  pnlSol: number;
  sizeSol: number;
  /** Realized entry slippage in bps (positive = paid more than expected). */
  execSlippageBps: number | null;
  /** True when the trade was rug/dump-driven (M3 rug high or rug/sl exit). */
  rugDriven: boolean;
};

export type PnlAttribution = {
  edgeSol: number;
  executionSol: number;
  marketSol: number;
};

export function attributePnl(t: TradeAttributionInput): PnlAttribution {
  // Execution drag: only the *adverse* portion of entry slippage is a cost.
  const slipBps = t.execSlippageBps != null && Number.isFinite(t.execSlippageBps) ? t.execSlippageBps : 0;
  const executionSol = -(Math.max(0, slipBps) / 10_000) * Math.max(0, t.sizeSol);

  // Market: a rug/adverse-move loss beyond execution is attributed to market,
  // leaving edge ≈ 0 (strategy not blamed for a rug). Only applies to losses.
  let marketSol = 0;
  if (t.rugDriven && t.pnlSol < 0) {
    marketSol = t.pnlSol - executionSol;
  }

  const edgeSol = t.pnlSol - executionSol - marketSol;
  return { edgeSol, executionSol, marketSol };
}

/** Fields stamped onto a closed position's entry_features for later aggregation. */
export function attributionFields(a: PnlAttribution): Record<string, number> {
  return {
    attr_edge_sol: a.edgeSol,
    attr_execution_sol: a.executionSol,
    attr_market_sol: a.marketSol,
  };
}
