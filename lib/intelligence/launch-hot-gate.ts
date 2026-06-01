/** Pure launch hot scoring (no server-only — safe for tests). */

export type LaunchActivity = {
  mint: string;
  creatorWallet: string;
  tradeCount: number;
  uniqueWallets: number;
  maxVSol: number;
};

export type LaunchGateConfig = {
  minVSol: number;
  minTrades: number;
  minUniqueWallets: number;
  minGates: number;
  minHotScore: number;
};

export type LaunchGateResult = {
  mint: string;
  qualified: boolean;
  hotScore: number;
  gatesPassed: number;
  reasons: string[];
};

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

export function scoreLaunchHot(
  activity: LaunchActivity,
  cfg: LaunchGateConfig,
): LaunchGateResult {
  const reasons: string[] = [];

  const liquidityScore = clamp01(activity.maxVSol / cfg.minVSol);
  const tradeScore = clamp01(activity.tradeCount / Math.max(1, cfg.minTrades));
  const nonCreatorWallets = Math.max(0, activity.uniqueWallets - 1);
  const diversityScore =
    nonCreatorWallets >= cfg.minUniqueWallets - 1
      ? 1
      : activity.tradeCount > 0 && activity.uniqueWallets >= 2
        ? 0.65
        : 0;
  const programTrustScore = 1;

  let gatesPassed = 0;
  if (activity.maxVSol >= cfg.minVSol) {
    gatesPassed++;
    reasons.push("liq");
  }
  if (activity.tradeCount >= cfg.minTrades) {
    gatesPassed++;
    reasons.push("trades");
  }
  if (nonCreatorWallets >= 1 || activity.uniqueWallets >= cfg.minUniqueWallets) {
    gatesPassed++;
    reasons.push("wallets");
  }

  const hotScore =
    liquidityScore * 0.35 +
    tradeScore * 0.3 +
    diversityScore * 0.25 +
    programTrustScore * 0.1;

  const qualified = gatesPassed >= cfg.minGates && hotScore >= cfg.minHotScore;

  return {
    mint: activity.mint,
    qualified,
    hotScore,
    gatesPassed,
    reasons,
  };
}
