import type { RiskPreset } from "@/lib/shared/types";

export type RiskBudget = {
  sizePerTradeSol: number;
  maxConcurrent: number;
  tpPct: number;
  slPct: number;
  maxHoldMinutes: number;
  pumpFeesPct: number;
  paperSlippagePct: number;
};

const PRESETS: Record<RiskPreset, RiskBudget> = {
  conservative: {
    sizePerTradeSol: 0.03,
    maxConcurrent: 3,
    tpPct: 0.5,
    slPct: 0.2,
    maxHoldMinutes: 20,
    pumpFeesPct: 0.01,
    paperSlippagePct: 0.01,
  },
  balanced: {
    sizePerTradeSol: 0.03,
    maxConcurrent: 3,
    tpPct: 0.45,
    slPct: 0.15,
    maxHoldMinutes: 25,
    pumpFeesPct: 0.01,
    paperSlippagePct: 0.01,
  },
  aggressive: {
    sizePerTradeSol: 0.1,
    maxConcurrent: 8,
    tpPct: 1.5,
    slPct: 0.4,
    maxHoldMinutes: 45,
    pumpFeesPct: 0.01,
    paperSlippagePct: 0.015,
  },
  // Wider TP so a win clears the ~2% round-trip friction on the non-linear
  // bonding curve (where small nominal moves net to zero after fees+slippage).
  profit_seek: {
    sizePerTradeSol: 0.05,
    maxConcurrent: 2,
    tpPct: 0.35,
    slPct: 0.12,
    maxHoldMinutes: 35,
    pumpFeesPct: 0.01,
    paperSlippagePct: 0.01,
  },
  // Fast newborn scalps: tight stop, quick scratch, small size, more slippage.
  launch_snipe: {
    sizePerTradeSol: 0.04,
    maxConcurrent: 3,
    tpPct: 0.6,
    slPct: 0.18,
    maxHoldMinutes: 12,
    pumpFeesPct: 0.01,
    paperSlippagePct: 0.015,
  },
};

export function riskBudgetFor(preset: RiskPreset): RiskBudget {
  return PRESETS[preset];
}
