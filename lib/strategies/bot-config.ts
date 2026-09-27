import { STRATEGIES, type StrategyId, type ExecutionSetting } from "./catalog";

export function researchStrategy(value: unknown): StrategyId | null {
  return typeof value === "string" && Object.hasOwn(STRATEGIES, value) ? value as StrategyId : null;
}

export function researchPreset(strategy: StrategyId, setting: ExecutionSetting = "BASE") {
  return {
    researchStrategy: strategy, researchExecution: setting,
    sizeSol: STRATEGIES[strategy].size, maxHoldMinutes: STRATEGIES[strategy].hold / 60,
    takeProfitPct: 0, stopLossPct: 0, tp1Pct: 0, tp1Fraction: 0,
    trailingArmPct: 0, trailingStopPct: 0, stagnationMinutes: 0, stagnationMaxPeakPct: 0,
    requireCurveLadder: false, useLearnedAvoids: false,
  };
}
