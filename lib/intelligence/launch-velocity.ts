/**
 * Launch-velocity scoring (PURE — no server-only, safe for tests).
 *
 * The alpha core for fresh launches. It does NOT predict price; it predicts
 * "will this token attract *sustained liquidity* in the next 2–10 minutes?"
 * from the first ~0–60s of activity. This replaces the maturity bias (which
 * favored already-pumped, high-mcap tokens) with a velocity bias.
 *
 * Score ∈ [0,1] = Σ(weight · subscore). Hard vetoes force the score to 0
 * regardless of the weighted sum (rug fingerprint, single-wallet/bundle launch,
 * dev early-dump, liquidity thinning). See plan Appendix B.
 *
 * Inputs are intentionally tolerant: richer fields (bot/cluster concentration,
 * exact early-buy counts) are optional and fall back to neutral proxies so the
 * model degrades gracefully on the live snapshot.
 */

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

export type LaunchVelocityInput = {
  /** Current bonding-curve liquidity (SOL or USD — unit-agnostic, see priorVSol). */
  vSol: number;
  /** Prior liquidity one delta ago (same unit as vSol), if known — for growth. */
  priorVSol?: number;
  /** Recent buy count (e.g. last 30–60s); falls back to 0 when unknown. */
  buys?: number;
  /** Distinct non-creator buyers seen so far. */
  uniqueBuyers: number;
  /** buy volume / (buy+sell) volume, ∈ [0,1]. */
  buySellRatio: number;
  /** Cluster/bot concentration ∈ [0,1]; 0 = fully organic. Optional. */
  clusterConcentration?: number;
  /** Absolute early price impulse (%, e.g. |price_change_m5|). */
  priceImpulsePct?: number;
  // Veto signals (any true → score 0):
  rugFingerprint?: boolean;
  bundleLaunch?: boolean;
  singleWalletLaunch?: boolean;
  devEarlyDump?: boolean;
};

export type LaunchVelocityConfig = {
  /** Relative liquidity growth between snapshots mapping to subscore 1.0 (e.g. 0.5 = +50%). */
  targetRelGrowth: number;
  /** Target recent buys mapping to subscore 1.0. */
  targetBuys: number;
  /** Target unique buyers mapping to subscore 1.0. */
  targetUniqueBuyers: number;
  /** Min adequate liquidity (same unit as vSol) for the initial-liquidity subscore. */
  minVSol: number;
  /** Cap (%) for the early-volatility subscore. */
  volatilityCapPct: number;
};

export const DEFAULT_VELOCITY_CONFIG: LaunchVelocityConfig = {
  targetRelGrowth: 0.5,
  targetBuys: 15,
  targetUniqueBuyers: 8,
  minVSol: 12,
  volatilityCapPct: 60,
};

const WEIGHTS = {
  liqGrowthRate: 0.26,
  buyVelocity: 0.2,
  uniqueBuyerGrowth: 0.18,
  buySellRatio: 0.12,
  organicDistribution: 0.12,
  initialLiqAdequacy: 0.06,
  earlyVolatilitySpike: 0.06,
} as const;

export type LaunchVelocityResult = {
  score: number;
  vetoed: boolean;
  vetoReason: string | null;
  subscores: Record<keyof typeof WEIGHTS, number>;
  reasons: string[];
};

export function scoreLaunchVelocity(
  input: LaunchVelocityInput,
  cfg: LaunchVelocityConfig = DEFAULT_VELOCITY_CONFIG,
): LaunchVelocityResult {
  // Relative liquidity growth between snapshots. Falls back to 0 when no prior.
  let relGrowth = 0;
  if (input.priorVSol != null && input.priorVSol > 0) {
    relGrowth = (input.vSol - input.priorVSol) / input.priorVSol;
  }
  // Liquidity thinning over the window is a hard veto (the launch is bleeding).
  const thinning = input.priorVSol != null && input.vSol < input.priorVSol * 0.85;

  const vetoReason =
    input.rugFingerprint ? "rug_fingerprint"
    : input.singleWalletLaunch ? "single_wallet_launch"
    : input.bundleLaunch ? "bundle_launch"
    : input.devEarlyDump ? "dev_early_dump"
    : thinning ? "liquidity_thinning"
    : null;

  const subscores: Record<keyof typeof WEIGHTS, number> = {
    liqGrowthRate: clamp01(relGrowth / cfg.targetRelGrowth),
    buyVelocity: clamp01((input.buys ?? 0) / cfg.targetBuys),
    uniqueBuyerGrowth: clamp01(input.uniqueBuyers / cfg.targetUniqueBuyers),
    buySellRatio: clamp01((input.buySellRatio - 0.5) / 0.4),
    organicDistribution: clamp01(1 - (input.clusterConcentration ?? 0.3)),
    initialLiqAdequacy: clamp01(input.vSol / cfg.minVSol),
    earlyVolatilitySpike: clamp01(Math.abs(input.priceImpulsePct ?? 0) / cfg.volatilityCapPct),
  };

  const weighted = (Object.keys(WEIGHTS) as Array<keyof typeof WEIGHTS>).reduce(
    (acc, k) => acc + WEIGHTS[k] * subscores[k],
    0,
  );

  const score = vetoReason ? 0 : clamp01(weighted);
  const reasons = vetoReason
    ? [`veto:${vetoReason}`]
    : [
        `liqGrow=${subscores.liqGrowthRate.toFixed(2)}`,
        `buyVel=${subscores.buyVelocity.toFixed(2)}`,
        `uniq=${subscores.uniqueBuyerGrowth.toFixed(2)}`,
        `bsr=${subscores.buySellRatio.toFixed(2)}`,
        `organic=${subscores.organicDistribution.toFixed(2)}`,
      ];

  return { score, vetoed: vetoReason != null, vetoReason, subscores, reasons };
}
