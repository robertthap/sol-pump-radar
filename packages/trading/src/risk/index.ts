import type { PaperRuntimeConfig } from "../config";

export type PortfolioSnapshot = {
  balanceSol: number;
  realizedPnlSol: number;
  openPositions: number;
};

export type RiskCheckInput = {
  notionalSol: number;
  portfolio: PortfolioSnapshot;
  /** Sum of losses already taken today (positive number). */
  todayLossSol: number;
  config: PaperRuntimeConfig;
};

export type RiskCheckResult =
  | { ok: true }
  | { ok: false; reason: string; code: string };

export function checkRisk(input: RiskCheckInput): RiskCheckResult {
  const { notionalSol, portfolio, todayLossSol, config } = input;

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
  return { ok: true };
}
