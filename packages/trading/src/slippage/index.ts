/**
 * Slippage model: realistic enough to punish small-liq mints without being
 * a fantasy. Buy = price moves up, Sell = price moves down. Magnitude scales
 * with notional / liquidity proxy.
 */

export type SlippageInput = {
  side: "BUY" | "SELL";
  /** Quote price (v_sol on bonding curve). */
  quotePrice: number;
  /** Order notional in SOL. */
  notionalSol: number;
  /** Optional liquidity-like reference (v_sol proxy). When small, slippage grows. */
  referenceVSol?: number | null;
  /** Base slippage in bps (e.g. 50 = 0.5%). */
  baseBps?: number;
};

export type SlippageOutput = {
  fillPrice: number;
  slippageBps: number;
};

export function applySlippage(input: SlippageInput): SlippageOutput {
  const baseBps = Math.max(0, input.baseBps ?? 30);
  const ref = input.referenceVSol && input.referenceVSol > 0 ? input.referenceVSol : 50;
  // impact term: 100 bps per 1% of pool consumed; capped at 800 bps.
  const consumed = input.notionalSol / ref;
  const impactBps = Math.min(800, consumed * 10_000);
  const totalBps = baseBps + impactBps;
  const sign = input.side === "BUY" ? 1 : -1;
  const fillPrice = input.quotePrice * (1 + (sign * totalBps) / 10_000);
  return {
    fillPrice: Math.max(1e-12, fillPrice),
    slippageBps: Math.round(totalBps),
  };
}
