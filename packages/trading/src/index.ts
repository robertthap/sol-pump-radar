export type { PaperRuntimeConfig } from "./config";
export {
  percentiles, latencyProfile, fillLatency, sampleFillLatencyMs,
  type LatencyStage, type StageSamples, type Percentiles,
  type LatencyProfile, type FillLatency,
} from "./latency";
export {
  canonicalConfig, configHash, measurementIntegrity, tradeProvenance,
  type OutcomeAffectingConfig, type AdaptiveSwitches,
  type MeasurementIntegrity, type TradeProvenance,
} from "./provenance";
export {
  RISK_TIMEZONE, startOfRiskDay, riskDayWindow, riskDayKey, isSameRiskDay, dailyLossSol,
} from "./risk-day";
export {
  LAMPORTS_PER_SOL, MAX_SAFE_SOL,
  solToLamports, lamportsToSol, tokensToRaw, rawToTokens, rawToDecimalString,
  sumLamports, applyBpsExact,
} from "./amounts";
export {
  CURVE_FEE, AMM_FEE, BASE_TX_FEE_SOL, ATA_RENT_SOL,
  venueFee, tradingFeeBps, tradingFeeSol, txCostSol, failedTxCostSol,
  ataRentSol, roundTripCostSol,
  type VenueFee, type Venue, type FeeModel, type RoundTrip,
} from "./fees";
export {
  researchBuy,
  researchClose,
  researchCloseAtMark,
  researchCensor,
  researchFailureFee,
} from "./paper/research";
export { paperConfigFromEnv } from "./config";
export type { PositionState } from "./state-machine";
export { assertTransition, isTerminal, InvalidTransitionError } from "./state-machine";
export { applySlippage } from "./slippage";
export type { SlippageInput, SlippageOutput } from "./slippage";
export {
  unrealizedPnlSol,
  realizedPnlSol,
  pctOfSize,
  curveValueRatio,
  curveRealizedPnlSol,
  curveUnrealizedPnlSol,
  curveExitSettlement,
  type ExitSettlement,
} from "./pnl";
export type { PortfolioSnapshot, RiskCheckInput, RiskCheckResult } from "./risk";
export { checkRisk } from "./risk";
export type { PriceQuote, PriceResolver } from "./pricing";
export {
  ensurePortfolio,
  loadPortfolio,
  loadOpenPositions,
  type PortfolioRow,
  type PositionRow,
} from "./portfolio";
export {
  openPosition,
  closePosition,
  partialClosePosition,
  markToMarket,
  resetPortfolio,
  todayRealizedLossSol,
  type OpenIntent,
  type EntryHealth,
  type CloseIntent,
  type PartialCloseIntent,
  type ResetIntent,
  type ExecutionResult,
} from "./paper/executor";
