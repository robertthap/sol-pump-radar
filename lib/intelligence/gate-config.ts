/**
 * Mode + stage-aware auto-trade gate configuration (PURE — no server-only).
 *
 * This replaces the previously hard-coded liquidity/rank literals that biased the
 * auto-trader toward mature, high-market-cap tokens (Engine A `BUY_STRONG` once
 * required `liquidity_usd >= 20_000` AND `rank >= 0.8`, which fresh launches can
 * never satisfy). Floors now come from a config object that:
 *   - varies by {@link SignalMode} (launch / hybrid / profit), and
 *   - is tunable by the learner via {@link resolveGateConfig} overrides.
 *
 * Keep this module pure so both the pure gate core ({@link ./auto-gate-core}) and
 * unit tests can import it without the server-only boundary.
 */
import { clampToDeviation, clampToFraction } from "@/lib/tuner/limits";

export type SignalMode = "launch" | "profit" | "hybrid";

export type AutoGateConfig = {
  /** Hard base liquidity floor (USD) below which nothing auto-trades. */
  liqFloorBaseUsd: number;
  engineA: {
    /** Engine A (launch) liquidity floor (USD). */
    liqFloorUsd: number;
    /** Engine A cross-mint rank percentile floor [0..1]. */
    rankFloor: number;
    /** Min launch-velocity score [0..1]; 0 disables (until L2.1 wires it in). */
    velocityFloor: number;
    /** Launch states eligible for BUY_STRONG / auto-trade. */
    allowStates: readonly string[];
    /** Whether BUY_MODERATE is also eligible for auto-trade (newborn tiers). */
    allowModerateAuto: boolean;
  };
  engineB: {
    /** Engine B (continuation) rank percentile floor [0..1]. */
    rankFloor: number;
    /** Extension guard: reject when `price_change_h1 * 2` exceeds this (%). */
    maxExtensionPct: number;
  };
};

/** Learner-supplied overrides (clamped in {@link resolveGateConfig}). */
export type GateOverrides = {
  liqFloorBaseUsd?: number;
  engineALiqFloorUsd?: number;
  engineARankFloor?: number;
  engineAVelocityFloor?: number;
  engineBRankFloor?: number;
};

/**
 * Per-mode preset defaults.
 *
 * - `profit` keeps the original conservative, low-variance behavior (mature
 *   tokens only) — this is what the old literals encoded.
 * - `launch` opens the newborn tier: low liquidity + relaxed rank so fresh,
 *   high-velocity launches can enter (risk vetoes + vol acceleration still apply).
 * - `hybrid` runs both tiers.
 */
export function defaultGateConfig(mode: SignalMode): AutoGateConfig {
  switch (mode) {
    case "launch":
      return {
        liqFloorBaseUsd: 1_500,
        engineA: {
          liqFloorUsd: 1_500,
          rankFloor: 0.5,
          velocityFloor: 0.4,
          allowStates: ["launching", "early_breakout", "acceleration"],
          allowModerateAuto: true,
        },
        engineB: { rankFloor: 0.85, maxExtensionPct: 300 },
      };
    case "hybrid":
      return {
        liqFloorBaseUsd: 2_000,
        engineA: {
          liqFloorUsd: 3_000,
          rankFloor: 0.55,
          velocityFloor: 0.38,
          allowStates: ["launching", "early_breakout", "acceleration"],
          allowModerateAuto: true,
        },
        engineB: { rankFloor: 0.85, maxExtensionPct: 300 },
      };
    case "profit":
    default:
      return {
        liqFloorBaseUsd: 8_000,
        engineA: {
          liqFloorUsd: 20_000,
          rankFloor: 0.8,
          velocityFloor: 0,
          allowStates: ["early_breakout", "acceleration"],
          allowModerateAuto: false,
        },
        engineB: { rankFloor: 0.85, maxExtensionPct: 300 },
      };
  }
}

/**
 * Merge learner overrides into the preset defaults, each clamped to a bounded
 * deviation from the preset so learning can tighten/loosen but never blow the
 * gates wide open.
 */
export function resolveGateConfig(
  mode: SignalMode,
  overrides: GateOverrides = {},
): AutoGateConfig {
  const base = defaultGateConfig(mode);
  const cfg: AutoGateConfig = {
    liqFloorBaseUsd: base.liqFloorBaseUsd,
    engineA: { ...base.engineA, allowStates: [...base.engineA.allowStates] },
    engineB: { ...base.engineB },
  };
  if (overrides.liqFloorBaseUsd != null) {
    cfg.liqFloorBaseUsd = clampToFraction(overrides.liqFloorBaseUsd, base.liqFloorBaseUsd);
  }
  if (overrides.engineALiqFloorUsd != null) {
    cfg.engineA.liqFloorUsd = clampToFraction(overrides.engineALiqFloorUsd, base.engineA.liqFloorUsd);
  }
  if (overrides.engineARankFloor != null) {
    cfg.engineA.rankFloor = clampToDeviation(overrides.engineARankFloor, base.engineA.rankFloor);
  }
  if (overrides.engineAVelocityFloor != null) {
    cfg.engineA.velocityFloor = clampToDeviation(overrides.engineAVelocityFloor, base.engineA.velocityFloor);
  }
  if (overrides.engineBRankFloor != null) {
    cfg.engineB.rankFloor = clampToDeviation(overrides.engineBRankFloor, base.engineB.rankFloor);
  }
  return cfg;
}
