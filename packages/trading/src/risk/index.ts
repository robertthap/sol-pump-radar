import type { PaperRuntimeConfig } from "../config";

export type PortfolioSnapshot = {
  balanceSol: number;
  realizedPnlSol: number;
  openPositions: number;
};

/** Circuit-breaker states. Only RUNNING may open NEW positions (H09). */
export type BreakerState = "RUNNING" | "DEGRADED" | "PAUSED" | "HALTED";

export type RiskCheckInput = {
  notionalSol: number;
  portfolio: PortfolioSnapshot;
  /** Sum of losses already taken today (positive number). */
  todayLossSol: number;
  config: PaperRuntimeConfig;
  /**
   * H09 — health of the inputs this decision rests on. All optional in the type
   * only so existing call sites compile; each one FAILS CLOSED when absent,
   * because "nobody told me" is not the same as "healthy".
   */
  breakerState?: BreakerState;
  /** Age of the market data behind this decision. null = unknown = stale. */
  dataAgeMs?: number | null;
  feedDegraded?: boolean;
  /** Current and high-water equity, for the peak-to-trough drawdown limit. */
  equitySol?: number;
  peakEquitySol?: number;
  /** H10 — notional already open in THIS mint. */
  mintOpenNotionalSol?: number;
};

export type RiskCheckResult =
  | { ok: true }
  | { ok: false; reason: string; code: string };

/**
 * Gate a NEW paper entry.
 *
 * Exits are deliberately NOT gated by this: a degraded feed or a breached
 * drawdown limit is a reason to stop BUYING, never a reason to abandon a
 * position that is already open. The exit lane manages those regardless.
 */
export function checkRisk(input: RiskCheckInput): RiskCheckResult {
  const { notionalSol, portfolio, todayLossSol, config } = input;

  // ---- H09: is the system in a state where a new entry is defensible? ----
  // Checked FIRST: everything below reasons about numbers that came from the
  // feed, so their health is a precondition for trusting any of them.
  const breaker = input.breakerState ?? "DEGRADED"; // unknown -> not RUNNING
  if (breaker !== "RUNNING") {
    return { ok: false, code: "BREAKER", reason: `circuit breaker is ${breaker}` };
  }
  if (input.feedDegraded !== false) {
    return {
      ok: false, code: "FEED_DEGRADED",
      reason: input.feedDegraded == null ? "feed health unknown" : "feed is degraded",
    };
  }
  const ageMs = input.dataAgeMs;
  if (ageMs == null || !Number.isFinite(ageMs) || ageMs >= config.maxDataStalenessMs) {
    return {
      ok: false, code: "STALE_DATA",
      reason: ageMs == null ? "market data age unknown" : `data ${Math.round(ageMs)}ms old`,
    };
  }

  // ---- H09: peak-to-trough drawdown, measured from the high-water mark ----
  // Measuring from the STARTING balance would call a fall from 20 to 11 a
  // profit; it is a 45% drawdown and the account is bleeding.
  const peak = input.peakEquitySol;
  const equity = input.equitySol;
  if (peak != null && equity != null && peak > 0) {
    const drawdown = (peak - equity) / peak;
    if (drawdown > config.maxDrawdownPct) {
      return {
        ok: false, code: "DRAWDOWN",
        reason: `drawdown ${(drawdown * 100).toFixed(1)}% > ${(config.maxDrawdownPct * 100).toFixed(0)}% from peak ${peak.toFixed(3)}`,
      };
    }
  }

  if (!Number.isFinite(notionalSol) || notionalSol <= 0) {
    return { ok: false, code: "BAD_SIZE", reason: `invalid size ${notionalSol}` };
  }
  if (notionalSol > config.maxPositionSol) {
    return {
      ok: false,
      code: "OVER_MAX_POSITION",
      reason: `size ${notionalSol} > PAPER_MAX_POSITION_SOL ${config.maxPositionSol}`,
    };
  }
  if (notionalSol > portfolio.balanceSol) {
    return {
      ok: false,
      code: "INSUFFICIENT_BALANCE",
      reason: `size ${notionalSol} > balance ${portfolio.balanceSol.toFixed(4)}`,
    };
  }
  if (portfolio.openPositions >= config.maxOpenPositions) {
    return {
      ok: false,
      code: "MAX_CONCURRENT",
      reason: `${portfolio.openPositions} positions open >= ${config.maxOpenPositions}`,
    };
  }
  if (todayLossSol >= config.dailyLossLimitSol) {
    return {
      ok: false,
      code: "DAILY_LOSS_CAP",
      reason: `daily loss ${todayLossSol.toFixed(3)} >= ${config.dailyLossLimitSol}`,
    };
  }
  // H10 — per-token exposure. The NEW position counts toward the limit: the
  // question is what we would hold AFTER this fill, not what we hold now.
  const inMint = input.mintOpenNotionalSol ?? 0;
  if (inMint + notionalSol > config.maxPerMintSol) {
    return {
      ok: false,
      code: "MAX_PER_MINT",
      reason: `${(inMint + notionalSol).toFixed(3)} SOL in this mint > PAPER_MAX_PER_MINT_SOL ${config.maxPerMintSol}`,
    };
  }
  return { ok: true };
}
