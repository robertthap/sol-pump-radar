/**
 * Market-regime detection (PURE — no server-only, testable).
 *
 * "Sit out bad regimes rather than overtrade" (the antidote to bleeding slowly).
 * Classifies the current pump.fun market from rolling universe stats and returns
 * a risk multiplier that tightens (or slightly loosens) the auto-trade gate.
 *
 *   risk_on        — broad positive momentum + healthy launch flow → loosen a touch
 *   neutral        — default
 *   low_liquidity  — thin/quiet universe → fewer real opportunities → tighten
 *   high_rug       — manipulation/rug-heavy tape → tighten hard
 */
import type { AutoGateConfig } from "@/lib/intelligence/gate-config";

export type MarketRegime = "risk_on" | "neutral" | "low_liquidity" | "high_rug";

export type RegimeStats = {
  /** Number of mints in the active universe this tick. */
  universeSize: number;
  /** Fraction [0..1] flagged rug / rug-risk. */
  rugFraction: number;
  /** Fraction [0..1] that are fresh launches (young / new pool). */
  freshFraction: number;
  /** Fraction [0..1] with positive short-term momentum. */
  positiveMomFraction: number;
};

export type RegimeResult = {
  regime: MarketRegime;
  /** Multiplier applied to gate floors: >1 stricter, <1 looser. */
  riskMultiplier: number;
  reason: string;
};

export function classifyRegime(s: RegimeStats): RegimeResult {
  // High-rug tape dominates everything — protect capital.
  if (s.rugFraction >= 0.5) {
    return { regime: "high_rug", riskMultiplier: 1.25, reason: `rugFraction=${s.rugFraction.toFixed(2)}` };
  }
  // Too few names or too quiet → not enough real opportunity; be picky.
  if (s.universeSize < 8 || (s.freshFraction < 0.1 && s.positiveMomFraction < 0.25)) {
    return {
      regime: "low_liquidity",
      riskMultiplier: 1.1,
      reason: `universe=${s.universeSize} fresh=${s.freshFraction.toFixed(2)} mom=${s.positiveMomFraction.toFixed(2)}`,
    };
  }
  // Broad momentum + healthy launch flow and low rug → lean in slightly.
  if (s.positiveMomFraction >= 0.5 && s.freshFraction >= 0.25 && s.rugFraction < 0.3) {
    return {
      regime: "risk_on",
      riskMultiplier: 0.9,
      reason: `mom=${s.positiveMomFraction.toFixed(2)} fresh=${s.freshFraction.toFixed(2)}`,
    };
  }
  return { regime: "neutral", riskMultiplier: 1.0, reason: "default" };
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/**
 * Apply a regime's risk multiplier to the gate's quality floors. We tighten
 * velocity and rank (and raise the launch-tier rug-sensitive liquidity floor in
 * the worst regime) but never relax the absolute base liquidity floor.
 */
export function regimeAdjustedConfig(cfg: AutoGateConfig, r: RegimeResult): AutoGateConfig {
  if (r.riskMultiplier === 1) return cfg;
  const m = r.riskMultiplier;
  return {
    ...cfg,
    engineA: {
      ...cfg.engineA,
      allowStates: [...cfg.engineA.allowStates],
      velocityFloor: clamp01(cfg.engineA.velocityFloor * m),
      rankFloor: clamp01(cfg.engineA.rankFloor * m),
      // In a rug-heavy regime, require more liquidity even for launch entries.
      liqFloorUsd: r.regime === "high_rug" ? cfg.engineA.liqFloorUsd * 1.5 : cfg.engineA.liqFloorUsd,
    },
    engineB: {
      ...cfg.engineB,
      rankFloor: clamp01(cfg.engineB.rankFloor * m),
    },
  };
}

// Last-observed regime, for diagnostics surfaces (read-only snapshot).
let currentRegime: RegimeResult & { at: number } = {
  regime: "neutral",
  riskMultiplier: 1,
  reason: "init",
  at: 0,
};

export function setCurrentRegime(r: RegimeResult): void {
  currentRegime = { ...r, at: Date.now() };
}

export function getCurrentRegime(): RegimeResult & { at: number } {
  return currentRegime;
}

/** Compute regime stats from per-mint snapshots already loaded by the commit worker. */
export function regimeStatsFrom(
  rows: Array<{ ageSeconds: number; isNewPool: boolean; priceChangeM5: number; rug: boolean }>,
): RegimeStats {
  const n = rows.length;
  if (n === 0) {
    return { universeSize: 0, rugFraction: 0, freshFraction: 0, positiveMomFraction: 0 };
  }
  let rug = 0;
  let fresh = 0;
  let posMom = 0;
  for (const r of rows) {
    if (r.rug) rug++;
    if (r.isNewPool || r.ageSeconds < 300) fresh++;
    if (r.priceChangeM5 > 0) posMom++;
  }
  return {
    universeSize: n,
    rugFraction: rug / n,
    freshFraction: fresh / n,
    positiveMomFraction: posMom / n,
  };
}
