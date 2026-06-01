/**
 * M5 — Wash / fake volume
 *
 * Estimates the share of observed activity that is artificial. Combines:
 *   - bump bot wallets (paper Alg.3) — direct wash trading evidence
 *   - sells_5m / buys_5m close to 1.0 with low net flow — suggestive of
 *     bidirectional churn rather than directional accumulation
 *   - low unique buyers vs trade count — repetitive single-wallet activity
 *
 * Score in [0,1]: 0 = volume looks organic, 1 = mostly wash.
 */
export type WashFeatures = {
  bumpWalletCount: number;
  buys5m: number;
  sells5m: number;
  buyVol5m: number;
  sellVol5m: number;
  uniqueBuyers5m: number;
  trades5m: number;
};

export type WashScore = {
  score: number;
  reasons: string[];
};

function clamp01(x: number) {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

export function scoreWash(f: WashFeatures): WashScore {
  const reasons: string[] = [];

  // Bump bot direct evidence
  const bump = clamp01(f.bumpWalletCount / 5);
  if (f.bumpWalletCount > 0) reasons.push(`${f.bumpWalletCount} bump-bot wallets`);

  // Symmetric flow — equal-weight buys vs sells on small wallet diversity is
  // the signature of bidirectional wash.
  const totalTrades = f.buys5m + f.sells5m;
  let symmetryPenalty = 0;
  if (totalTrades >= 10) {
    const ratio = f.sells5m / Math.max(1, f.buys5m);
    const closeToOne = 1 - Math.min(1, Math.abs(ratio - 1));
    const volSymmetry =
      f.buyVol5m + f.sellVol5m > 0
        ? 1 - Math.min(1, Math.abs(f.buyVol5m - f.sellVol5m) / (f.buyVol5m + f.sellVol5m))
        : 0;
    symmetryPenalty = clamp01((closeToOne * 0.5 + volSymmetry * 0.5));
    if (symmetryPenalty >= 0.7)
      reasons.push(`symmetric flow (${f.buys5m}b/${f.sells5m}s, vol ${f.buyVol5m.toFixed(2)}/${f.sellVol5m.toFixed(2)})`);
  }

  // Repetition: many trades, few unique buyers
  let repetition = 0;
  if (f.trades5m >= 12 && f.uniqueBuyers5m >= 1) {
    const trPerBuyer = f.trades5m / f.uniqueBuyers5m;
    repetition = clamp01((trPerBuyer - 4) / 12);
    if (repetition >= 0.4)
      reasons.push(`${trPerBuyer.toFixed(1)} trades per unique buyer`);
  }

  const score = clamp01(0.5 * bump + 0.3 * symmetryPenalty + 0.2 * repetition);
  return { score, reasons };
}
