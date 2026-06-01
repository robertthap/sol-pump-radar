/**
 * Pre-trade micro-simulator (PURE — no server-only, testable). L3.6.
 *
 * Preflight (balance/caps) is necessary but not sufficient — most "death by
 * execution" losses come from entering into thin/volatile/MEV-heavy conditions.
 * Before a LIVE open we estimate expected slippage from pool depth + recent
 * volatility and reject when it's unsafe. Paper runs the same sim for parity
 * (logs what live *would* have done) but does not hard-reject.
 */

export type MicroSimInput = {
  /** Trade size (SOL). */
  sizeSol: number;
  /** Current pool/curve liquidity depth (SOL or USD — same unit as sizeSol's pool). */
  poolLiquiditySol: number;
  /** Recent short-window volatility proxy (%, e.g. |price_change_m1|). */
  recentVolatilityPct?: number;
  /** Plan's slippage tolerance (bps). */
  maxSlippageBps: number;
  /** Relative liquidity trend over the last window; negative = thinning. */
  liquidityTrend?: number;
  /** Priority fee being paid (SOL). */
  priorityFeeSol?: number;
  /** Expected/baseline priority fee (SOL); a large spike vs this is an anomaly. */
  baselinePriorityFeeSol?: number;
};

export type MicroSimResult = {
  ok: boolean;
  expectedSlippageBps: number;
  reason: string | null;
};

/** Liquidity thinning beyond this fraction over the window is a reject. */
const THINNING_REJECT = -0.15;
/** Priority-fee spike multiple vs baseline that flags a gas anomaly. */
const GAS_SPIKE_MULT = 4;

export function microSimulate(i: MicroSimInput): MicroSimResult {
  // Constant-product price impact for a buy of size S into depth L: S/(L+S).
  const impact = i.poolLiquiditySol > 0 ? i.sizeSol / (i.poolLiquiditySol + i.sizeSol) : 1;
  // Recent volatility widens the expected fill band (half-weighted, capped).
  const volBps = Math.min(2_000, Math.abs(i.recentVolatilityPct ?? 0) * 100) * 0.5;
  const expectedSlippageBps = Math.round(impact * 10_000 + volBps);

  if (expectedSlippageBps > i.maxSlippageBps) {
    return {
      ok: false,
      expectedSlippageBps,
      reason: `expected slippage ${expectedSlippageBps}bps > ${i.maxSlippageBps}bps tolerance`,
    };
  }
  if ((i.liquidityTrend ?? 0) < THINNING_REJECT) {
    return {
      ok: false,
      expectedSlippageBps,
      reason: `liquidity thinning ${((i.liquidityTrend ?? 0) * 100).toFixed(0)}% over window`,
    };
  }
  const base = i.baselinePriorityFeeSol ?? 0;
  if (base > 0 && (i.priorityFeeSol ?? 0) > base * GAS_SPIKE_MULT) {
    return {
      ok: false,
      expectedSlippageBps,
      reason: `priority-fee spike ${i.priorityFeeSol} >> baseline ${base}`,
    };
  }
  return { ok: true, expectedSlippageBps, reason: null };
}
