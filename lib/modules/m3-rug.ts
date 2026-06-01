export type RugFeatures = {
  currentVSol: number | null;
  peakVSol: number | null;
  buys5m: number;
  sells5m: number;
  buyVol5m: number;
  sellVol5m: number;
  top3BuyerShare: number | null;
  devSellVolSol: number;
  totalBuyVolSol: number;
  ageSeconds: number | null;
  // Kalacheva et al. 2026 features
  creationTradeDeltaSec?: number | null;
  rsi5m?: number | null;
  rsiStd5m?: number | null;
  totalSolFirst5m?: number | null;
};

export type RugScore = {
  score: number;
  components: {
    devSell: number;
    concentration: number;
    drawdown: number;
    sellPressure: number;
    babyDump: number;
    rushLaunch: number;
    erraticRsi: number;
    thinFirst5m: number;
  };
  reasons: string[];
};

function clamp(x: number, lo = 0, hi = 1): number {
  if (!Number.isFinite(x)) return lo;
  return Math.max(lo, Math.min(hi, x));
}

export function scoreRug(f: RugFeatures): RugScore {
  let devSell = 0;
  if (f.devSellVolSol > 0) {
    devSell = 0.6;
    if (f.totalBuyVolSol > 0) {
      const devShare = f.devSellVolSol / f.totalBuyVolSol;
      devSell = clamp(0.6 + devShare * 1.5);
    }
  }

  let concentration = 0;
  if (f.top3BuyerShare != null) {
    if (f.top3BuyerShare >= 0.85) concentration = 1.0;
    else if (f.top3BuyerShare >= 0.7) concentration = 0.8;
    else if (f.top3BuyerShare >= 0.55) concentration = 0.5;
    else if (f.top3BuyerShare >= 0.4) concentration = 0.25;
  }

  let drawdown = 0;
  if (f.peakVSol != null && f.currentVSol != null && f.peakVSol > 0) {
    const dropPct = (f.peakVSol - f.currentVSol) / f.peakVSol;
    if (dropPct >= 0.6) drawdown = 1.0;
    else if (dropPct >= 0.4) drawdown = 0.7;
    else if (dropPct >= 0.25) drawdown = 0.4;
    else if (dropPct >= 0.1) drawdown = 0.15;
  }

  const totalTrades = f.buys5m + f.sells5m;
  let sellPressure = 0;
  if (totalTrades >= 5) {
    const sellRatio = f.sells5m / totalTrades;
    if (sellRatio >= 0.75) sellPressure = 0.9;
    else if (sellRatio >= 0.6) sellPressure = 0.5;
    else if (sellRatio >= 0.5) sellPressure = 0.2;
  }

  let babyDump = 0;
  if (f.ageSeconds != null && f.ageSeconds < 300) {
    if (f.sellVol5m > f.buyVol5m * 0.8 && f.sellVol5m > 1) {
      babyDump = 0.8;
    }
  }

  // ──── Kalacheva et al. (2026) features ────────────────────────────────
  // Rush launches (creation→first-trade gap < 5s) had the strongest
  // correlation with rug pulls in their study. A delay of >30s suggests the
  // team built hype before opening trading and the token is more likely
  // legitimate.
  let rushLaunch = 0;
  if (f.creationTradeDeltaSec != null && f.creationTradeDeltaSec >= 0) {
    if (f.creationTradeDeltaSec < 2) rushLaunch = 0.7;
    else if (f.creationTradeDeltaSec < 5) rushLaunch = 0.45;
    else if (f.creationTradeDeltaSec < 10) rushLaunch = 0.2;
  }

  // Erratic RSI in the first 5 minutes — high std with extreme values
  // signals the price is being whipped around (typical of bundle dumps).
  let erraticRsi = 0;
  if (f.rsi5m != null && f.rsiStd5m != null) {
    const extreme = f.rsi5m < 0.2 || f.rsi5m > 0.95;
    const volatile = f.rsiStd5m > 0.25;
    if (extreme && volatile) erraticRsi = 0.55;
    else if (extreme) erraticRsi = 0.3;
    else if (volatile) erraticRsi = 0.2;
  }

  // Very thin first-5-min volume — the paper's #1 importance feature.
  // Low total SOL turnover correlates strongly with eventual rug.
  let thinFirst5m = 0;
  if (f.totalSolFirst5m != null && f.totalSolFirst5m >= 0) {
    if (f.totalSolFirst5m < 0.5) thinFirst5m = 0.5;
    else if (f.totalSolFirst5m < 2) thinFirst5m = 0.25;
  }

  const score = clamp(
    Math.max(
      0.95 * devSell,
      0.85 * concentration,
      0.85 * drawdown,
      0.7 * sellPressure,
      0.8 * babyDump,
      0.7 * rushLaunch,
      0.6 * erraticRsi,
      0.55 * thinFirst5m,
    ),
  );

  const reasons: string[] = [];
  if (devSell >= 0.6)
    reasons.push(`dev sold ${f.devSellVolSol.toFixed(2)} SOL`);
  if (concentration >= 0.5)
    reasons.push(`top-3 buyers hold ${Math.round((f.top3BuyerShare ?? 0) * 100)}% of buys`);
  if (drawdown >= 0.4)
    reasons.push(
      `v_sol drawdown ${Math.round(((f.peakVSol! - f.currentVSol!) / f.peakVSol!) * 100)}%`,
    );
  if (sellPressure >= 0.5) reasons.push(`sell-heavy (${f.buys5m}B/${f.sells5m}S)`);
  if (babyDump >= 0.5) reasons.push(`early dump`);
  if (rushLaunch >= 0.4) reasons.push(`rush launch (trade ${f.creationTradeDeltaSec?.toFixed(1)}s after mint)`);
  if (erraticRsi >= 0.4) reasons.push(`erratic 5m momentum (rsi=${f.rsi5m?.toFixed(2)} std=${f.rsiStd5m?.toFixed(2)})`);
  if (thinFirst5m >= 0.4) reasons.push(`thin first-5m volume (${f.totalSolFirst5m?.toFixed(2)} SOL)`);

  return {
    score,
    components: { devSell, concentration, drawdown, sellPressure, babyDump, rushLaunch, erraticRsi, thinFirst5m },
    reasons,
  };
}
