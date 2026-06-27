/**
 * Slippage model — deterministic pump.fun bonding-curve impact.
 *
 * THE MATH (the real fix per T0.3 of the v2 plan).
 * Pump.fun's constant-product virtual reserves: a buy of `notional` SOL into a
 * pool with pre-buy virtual SOL reserves `V` moves the reserves to `V + notional`.
 * The displaced vSol IS the curve impact — there is no separate "slippage
 * heuristic," only the mechanical reality that you swept the curve from V to
 * V+notional before any of it filled. The effective fill price (in vSol terms)
 * is the post-buy reserve level, so:
 *
 *     impact_fraction = notional / V        (= post/pre - 1)
 *     impact_bps      = impact_fraction * 10_000
 *
 * For a sell, the same math runs in reverse: tokens go IN, vSol comes OUT,
 * effective fill = post-sell reserves (lower).
 *
 * QUADRATIC PnL MAGNIFICATION (why even small bps matter).
 * Position value on the curve scales as vSol² (see packages/trading/src/pnl
 * and lib/dex/curve-mcap.ts). An entry at fillPrice = quotePrice·(1 + s) is
 * dampened on exit by ((1+s))² - 1 in value terms — a 5% vSol slippage at
 * entry costs ~10.25% in realized PnL when exiting at the same nominal vSol.
 * The slippageBps we return here is the vSol-fraction; the squaring happens
 * automatically downstream in `curveRealizedPnlSol`.
 *
 * CAP IS A BACKSTOP, NOT THE MODEL.
 * `impactCapBps = 5000` (50% vSol impact). The cap exists ONLY to bound
 * pathological inputs (e.g. notional ≥ pool size — physically the buy could
 * not complete on a single curve). The previous 800 bps cap (8%) was
 * dishonestly flattering on thin pools and corrupted any kill-gate decision
 * computed against paper PnL — the whole reason T0.3 exists.
 *
 * BASE BPS.
 * Default `baseBps = 30` accounts for network/router slippage independent of
 * pool depth. Add fee/priority-fee drag externally (the executor does this).
 */

export type SlippageInput = {
  side: "BUY" | "SELL";
  /** Quote price (v_sol on bonding curve at the moment we quoted). */
  quotePrice: number;
  /** Order notional in SOL. */
  notionalSol: number;
  /**
   * Pool liquidity reference in SOL (the v_sol_after of the most recent trade
   * on this mint). REQUIRED for honest slippage on thin pools — when omitted
   * we fall back to V=50 which is flattering for fresh-curve mints and was
   * called out as a measurement-integrity risk by T0.3.
   */
  referenceVSol?: number | null;
  /** Base slippage in bps (e.g. 50 = 0.5%). Default 30. */
  baseBps?: number;
};

export type SlippageOutput = {
  fillPrice: number;
  /** Combined base + curve-impact slippage, in bps of quotePrice (vSol terms). */
  slippageBps: number;
};

/** Backstop only — see module docstring. */
const IMPACT_CAP_BPS = 5000;

export function applySlippage(input: SlippageInput): SlippageOutput {
  const baseBps = Math.max(0, input.baseBps ?? 30);
  const preVSol =
    input.referenceVSol && input.referenceVSol > 0 ? input.referenceVSol : 50;
  // Deterministic curve impact: pool moves from preVSol → preVSol + notional.
  // impact_fraction = notional / preVSol → bps. Linear in vSol terms; the
  // quadratic value-PnL magnification happens downstream via curve PnL math.
  const consumed = input.notionalSol / preVSol;
  const impactBps = Math.min(IMPACT_CAP_BPS, consumed * 10_000);
  const totalBps = baseBps + impactBps;
  const sign = input.side === "BUY" ? 1 : -1;
  const fillPrice = input.quotePrice * (1 + (sign * totalBps) / 10_000);
  return {
    fillPrice: Math.max(1e-12, fillPrice),
    slippageBps: Math.round(totalBps),
  };
}
