/**
 * Honest strategy evaluation (H14) — PURE, no IO.
 *
 * Everything here exists to make a NEGATIVE result trustworthy. A harness that
 * can only find edges is worthless, because it will find one in noise; these
 * functions are built so that the no-edge answer is the one they reach by
 * default and an edge has to survive being attacked.
 *
 * The specific ways a memecoin backtest lies to you, and what is done about it:
 *
 *   look-ahead      splits are strictly time-ordered and verified, never
 *                   shuffled. A random K-fold on time series trains on the
 *                   future and is the single most common way a dead strategy
 *                   reports an edge.
 *   survivorship    censored rows are excluded by the CALLER's query, and the
 *                   count of what was excluded is carried through so a report
 *                   can state it rather than quietly shrinking.
 *   clustering      returns within one mint share a price path, so they are not
 *                   independent observations. The uncertainty interval
 *                   resamples whole MINTS, not individual trades; treating
 *                   trades as independent makes the interval far too narrow and
 *                   turns noise into significance.
 *   tail dominance  a mean driven by one 50x is reported alongside the median
 *                   and the trimmed mean, because the mean alone cannot be
 *                   traded.
 */

export type Trade = {
  /** Mint, for cluster-aware resampling. */
  mint: string;
  /** Decision time, for time-ordered splits. */
  ts: number;
  /** Net return after ALL costs, as a fraction (0.05 = +5%). */
  netReturn: number;
  /** Net PnL in SOL, for the equity curve and drawdown. */
  pnlSol: number;
  /** Venue phase, so pre- and post-graduation are reported separately. */
  phase?: "pre_graduation" | "post_graduation";
};

// ---------------------------------------------------------------- splits ----

export type Fold = { index: number; train: Trade[]; test: Trade[] };

/**
 * Walk-forward splits: train on the past, test on the next block, roll forward.
 *
 * Expanding window — each fold trains on everything before its test block. The
 * test block is always strictly LATER than its training data, which is the
 * property `assertNoLookAhead` verifies rather than assumes.
 */
export function walkForwardSplits(trades: readonly Trade[], folds: number): Fold[] {
  if (folds < 2) return [];
  const ordered = [...trades].sort((a, b) => a.ts - b.ts || a.mint.localeCompare(b.mint));
  if (ordered.length < folds + 1) return [];
  const blockSize = Math.floor(ordered.length / (folds + 1));
  if (blockSize < 1) return [];

  const out: Fold[] = [];
  for (let i = 1; i <= folds; i++) {
    const trainEnd = blockSize * i;
    const testEnd = i === folds ? ordered.length : blockSize * (i + 1);
    const train = ordered.slice(0, trainEnd);
    const test = ordered.slice(trainEnd, testEnd);
    if (train.length === 0 || test.length === 0) continue;
    out.push({ index: i, train, test });
  }
  return out;
}

/**
 * Verify no fold trains on data at or after its own test window.
 *
 * Returns the offending folds rather than throwing, so a report can state the
 * problem instead of dying. An empty array is the only acceptable result.
 */
export function assertNoLookAhead(folds: readonly Fold[]): Array<{ fold: number; reason: string }> {
  const problems: Array<{ fold: number; reason: string }> = [];
  for (const f of folds) {
    const lastTrain = Math.max(...f.train.map((t) => t.ts));
    const firstTest = Math.min(...f.test.map((t) => t.ts));
    if (!(lastTrain < firstTest)) {
      problems.push({
        fold: f.index,
        reason: `train reaches ${lastTrain} but test starts ${firstTest}`,
      });
    }
    // A mint appearing in both sides leaks its price path across the boundary.
    const trainMints = new Set(f.train.map((t) => t.mint));
    const overlap = [...new Set(f.test.map((t) => t.mint))].filter((m) => trainMints.has(m));
    if (overlap.length > 0) {
      problems.push({
        fold: f.index,
        reason: `${overlap.length} mint(s) appear in both train and test`,
      });
    }
  }
  return problems;
}

// ------------------------------------------------------------ statistics ----

export type TradeStats = {
  n: number;
  mints: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  /** Gross wins / gross losses. Infinity when there are no losses at all. */
  profitFactor: number;
  /** Mean net return per trade — the headline, and the most tail-sensitive. */
  evPerTrade: number;
  /** Median and 10% trimmed mean: what the typical trade did, tail removed. */
  medianReturn: number;
  trimmedMeanReturn: number;
  totalPnlSol: number;
  maxDrawdownSol: number;
  maxDrawdownPct: number;
};

const mean = (xs: readonly number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

function median(xs: readonly number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function trimmedMean(xs: readonly number[], trim = 0.1): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const cut = Math.floor(s.length * trim);
  const kept = s.slice(cut, s.length - cut);
  return mean(kept.length ? kept : s);
}

/** Peak-to-trough on the equity curve, in trade order. */
export function maxDrawdown(trades: readonly Trade[]): { sol: number; pct: number } {
  const ordered = [...trades].sort((a, b) => a.ts - b.ts);
  let equity = 0, peak = 0, worstSol = 0, worstPct = 0;
  for (const t of ordered) {
    equity += t.pnlSol;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > worstSol) worstSol = dd;
    // Percentage is only meaningful once the curve has been above water.
    if (peak > 0 && dd / peak > worstPct) worstPct = dd / peak;
  }
  return { sol: worstSol, pct: worstPct };
}

export function tradeStats(trades: readonly Trade[]): TradeStats {
  const returns = trades.map((t) => t.netReturn);
  const wins = trades.filter((t) => t.pnlSol > 0);
  const losses = trades.filter((t) => t.pnlSol < 0);
  const grossWin = wins.reduce((a, t) => a + t.pnlSol, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnlSol, 0));
  const dd = maxDrawdown(trades);
  return {
    n: trades.length,
    mints: new Set(trades.map((t) => t.mint)).size,
    winRate: trades.length ? wins.length / trades.length : 0,
    avgWin: mean(wins.map((t) => t.netReturn)),
    avgLoss: mean(losses.map((t) => t.netReturn)),
    profitFactor: grossLoss === 0 ? (grossWin > 0 ? Infinity : 0) : grossWin / grossLoss,
    evPerTrade: mean(returns),
    medianReturn: median(returns),
    trimmedMeanReturn: trimmedMean(returns),
    totalPnlSol: trades.reduce((a, t) => a + t.pnlSol, 0),
    maxDrawdownSol: dd.sol,
    maxDrawdownPct: dd.pct,
  };
}

// ----------------------------------------------------------- uncertainty ----

/** Deterministic RNG, so a reported interval can be reproduced exactly. */
function rng(seed: number): () => number {
  let h = seed >>> 0;
  return () => {
    h += 0x6d2b79f5;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Interval = { lo: number; hi: number; replicates: number };

/**
 * Bootstrap interval for EV per trade, resampling whole MINTS.
 *
 * Trades within one mint share a price path and are not independent. Resampling
 * individual trades would produce an interval perhaps 2-3x too narrow and call
 * noise significant. Returns null below two mints, where no interval is honest.
 */
export function evInterval(
  trades: readonly Trade[],
  { seed = 1701, replicates = 2000, alpha = 0.05 } = {},
): Interval | null {
  const byMint = new Map<string, Trade[]>();
  for (const t of trades) {
    const list = byMint.get(t.mint) ?? [];
    list.push(t);
    byMint.set(t.mint, list);
  }
  const mints = [...byMint.keys()];
  if (mints.length < 2) return null;

  const draw = rng(seed);
  const means: number[] = [];
  for (let i = 0; i < replicates; i++) {
    const sample: number[] = [];
    for (let j = 0; j < mints.length; j++) {
      for (const t of byMint.get(mints[Math.floor(draw() * mints.length)]!)!) {
        sample.push(t.netReturn);
      }
    }
    if (sample.length) means.push(mean(sample));
  }
  if (!means.length) return null;
  means.sort((a, b) => a - b);
  const at = (q: number) => means[Math.min(means.length - 1, Math.max(0, Math.floor(q * means.length)))]!;
  return { lo: at(alpha / 2), hi: at(1 - alpha / 2), replicates: means.length };
}

// ----------------------------------------------------------- calibration ----

export type Prediction = { p: number; outcome: boolean };

/**
 * Brier score: mean squared error of the probabilities. Lower is better.
 *
 * 0.25 is what you get by always predicting 0.5, so a score at or above that is
 * no better than refusing to predict.
 */
export function brierScore(predictions: readonly Prediction[]): number | null {
  const clean = predictions.filter((x) => Number.isFinite(x.p) && x.p >= 0 && x.p <= 1);
  if (!clean.length) return null;
  return mean(clean.map((x) => (x.p - (x.outcome ? 1 : 0)) ** 2));
}

export type ReliabilityBin = {
  lo: number; hi: number; n: number;
  meanPredicted: number; observedRate: number;
};

/**
 * Reliability: predicted probability vs what actually happened, per bin.
 *
 * A well-calibrated score has observedRate ≈ meanPredicted in every populated
 * bin. Empty bins are returned too — "the model never predicted this range" is
 * information, and dropping them hides it.
 */
export function reliabilityBins(
  predictions: readonly Prediction[],
  bins = 10,
): ReliabilityBin[] {
  const out: ReliabilityBin[] = [];
  for (let i = 0; i < bins; i++) {
    const lo = i / bins;
    const hi = (i + 1) / bins;
    const inBin = predictions.filter(
      (x) => Number.isFinite(x.p) && x.p >= lo && (i === bins - 1 ? x.p <= hi : x.p < hi),
    );
    out.push({
      lo, hi, n: inBin.length,
      meanPredicted: mean(inBin.map((x) => x.p)),
      observedRate: inBin.length ? inBin.filter((x) => x.outcome).length / inBin.length : 0,
    });
  }
  return out;
}

/** Largest gap between predicted and observed across populated bins. */
export function calibrationError(bins: readonly ReliabilityBin[]): number {
  const populated = bins.filter((b) => b.n > 0);
  if (!populated.length) return 0;
  const total = populated.reduce((a, b) => a + b.n, 0);
  // Weighted by bin population: a wild gap in a bin holding 3 samples is not
  // the same failure as a small gap in a bin holding 3000.
  return populated.reduce(
    (a, b) => a + (b.n / total) * Math.abs(b.observedRate - b.meanPredicted), 0,
  );
}

// ------------------------------------------------------------- ablation -----

export type AblationResult = {
  engine: string;
  withEv: number;
  withoutEv: number;
  /** withEv - withoutEv. Positive means the engine ADDS value. */
  delta: number;
  interval: Interval | null;
  /** True only when the interval excludes zero — i.e. the delta survives noise. */
  significant: boolean;
};

/**
 * What one engine contributes, by removing it.
 *
 * `significant` requires the bootstrap interval of the WITH-engine EV to
 * exclude the without-engine EV. A positive delta whose interval straddles that
 * point is not evidence, and is reported as not significant rather than as a
 * small win.
 */
export function ablation(
  engine: string,
  withEngine: readonly Trade[],
  withoutEngine: readonly Trade[],
  opts?: { seed?: number },
): AblationResult {
  const withEv = mean(withEngine.map((t) => t.netReturn));
  const withoutEv = mean(withoutEngine.map((t) => t.netReturn));
  const interval = evInterval(withEngine, { seed: opts?.seed ?? 1701 });
  return {
    engine,
    withEv,
    withoutEv,
    delta: withEv - withoutEv,
    interval,
    significant: interval != null && (interval.lo > withoutEv || interval.hi < withoutEv),
  };
}

// -------------------------------------------------------------- verdict -----

export type Verdict = {
  edge: boolean;
  reason: string;
  /** Everything that had to hold. Any false means no edge. */
  checks: Record<string, boolean>;
};

/**
 * The plain edge / no-edge call.
 *
 * Deliberately hard to pass. Every condition must hold, and the default answer
 * is NO EDGE — a strategy has to earn the other answer.
 */
export function verdict(input: {
  oos: TradeStats;
  interval: Interval | null;
  minTrades: number;
  minMints: number;
}): Verdict {
  const { oos, interval, minTrades, minMints } = input;
  const checks: Record<string, boolean> = {
    "enough trades": oos.n >= minTrades,
    "enough distinct mints": oos.mints >= minMints,
    "positive expected value out of sample": oos.evPerTrade > 0,
    "uncertainty interval excludes zero": interval != null && interval.lo > 0,
    "profit factor above 1": oos.profitFactor > 1,
    // A mean carried entirely by a tail cannot be traded: position sizing
    // cannot capture it and one missed outlier erases the result.
    "median trade is not a loss": oos.medianReturn >= 0,
  };
  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);
  return {
    edge: failed.length === 0,
    reason: failed.length === 0
      ? "every check passed out of sample"
      : `NO EDGE — failed: ${failed.join("; ")}`,
    checks,
  };
}
