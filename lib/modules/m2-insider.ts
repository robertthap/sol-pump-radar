/**
 * M2 — Insider concentration
 *
 * Detects when a single cluster of wallets has captured a disproportionate
 * share of the early demand. Inspired by:
 *  - "top3_buyer_share" we already compute
 *  - bundle/sniper wallet counts from the bot detector
 *  - early_unique_buyers vs total non-creator buyers
 *
 * Score in [0,1] where higher = more insider-concentrated and therefore
 * riskier for copiers (see paper §4.4 — bundle/sniper redistribute profits
 * away from late entrants).
 */
export type InsiderFeatures = {
  top3BuyerShare: number | null;
  uniqueBuyers5m: number;
  bundleWalletCount: number;
  sniperWalletCount: number;
  earlyUniqueBuyers: number;
  ageSeconds: number | null;
};

export type InsiderScore = {
  score: number;
  reasons: string[];
};

function clamp01(x: number) {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

export function scoreInsider(f: InsiderFeatures): InsiderScore {
  const reasons: string[] = [];

  // Top3 share: 0.5 = neutral, 1.0 = three wallets own everything.
  const top3 = clamp01((f.top3BuyerShare ?? 0));
  if (top3 >= 0.7) reasons.push(`top-3 buyers hold ${(top3 * 100).toFixed(0)}% of buy volume`);

  // Bundle/sniper presence — direct red flag from the paper detectors.
  const bundleSniperCount = f.bundleWalletCount + f.sniperWalletCount;
  const bsRatio = clamp01(bundleSniperCount / 10);
  if (f.bundleWalletCount > 0) reasons.push(`${f.bundleWalletCount} bundle wallets`);
  if (f.sniperWalletCount > 0) reasons.push(`${f.sniperWalletCount} sniper wallets`);

  // Crowd thinness: very few unique buyers relative to early activity → likely
  // wash/bundle pretending to be retail interest.
  const thin = f.uniqueBuyers5m < 5 && f.earlyUniqueBuyers >= 3 ? 0.6 : 0;
  if (thin > 0) reasons.push(`thin organic crowd (${f.uniqueBuyers5m} buyers/5m vs ${f.earlyUniqueBuyers} early)`);

  // For very young tokens we trust top3 less (small sample).
  const youngness = f.ageSeconds != null && f.ageSeconds < 60 ? 0.5 : 1.0;

  const score = clamp01(0.55 * top3 * youngness + 0.3 * bsRatio + 0.15 * thin);
  return { score, reasons };
}
