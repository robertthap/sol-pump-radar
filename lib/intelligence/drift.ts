/**
 * Population Stability Index (PSI) — pure, no IO. T1.3 drift / meta-shift core.
 *
 * PSI measures how much a feature's distribution has shifted between a BASELINE
 * window and a CURRENT window. The kill-gate (SYSTEM_DESIGN §8) uses PSI > 0.25
 * on the core feature vector as its observable "meta shift" condition — the
 * thing that makes "the window spanned a regime change" verifiable instead of a
 * matter of opinion.
 *
 * Conventional PSI interpretation:
 *   < 0.10  no significant shift
 *   0.10–0.25  moderate shift (watch)
 *   > 0.25  significant population shift  ← our meta-shift threshold
 *
 *   PSI = Σ_bins (cur% − base%) · ln(cur% / base%)
 *
 * Binning uses BASELINE quantiles (deciles by default), so bins are equal-mass
 * on the baseline and the index is robust to the feature's raw scale. Empty
 * bins are epsilon-floored to avoid ln(0) / divide-by-zero.
 */

export const META_SHIFT_PSI_THRESHOLD = 0.25;
const DEFAULT_BINS = 10;
const EPS = 1e-6;

/** Quantile (linear interpolation) of a numeric sample. q ∈ [0,1]. */
function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  if (q <= 0) return sorted[0]!;
  if (q >= 1) return sorted[sorted.length - 1]!;
  const idx = q * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  const frac = idx - lo;
  return sorted[lo]! * (1 - frac) + sorted[hi]! * frac;
}

/**
 * Bin edges from baseline quantiles. Returns `bins-1` interior edges (the outer
 * bounds are ±∞ implicitly). Degenerate (all-equal) baselines collapse to a
 * single bin — handled by the caller (PSI of a constant feature is 0).
 */
function baselineEdges(baseline: number[], bins: number): number[] {
  const sorted = [...baseline].sort((a, b) => a - b);
  const edges: number[] = [];
  for (let i = 1; i < bins; i++) {
    edges.push(quantile(sorted, i / bins));
  }
  // De-duplicate collapsed edges (heavy ties) so we don't create zero-width bins.
  const uniq: number[] = [];
  for (const e of edges) {
    if (uniq.length === 0 || e > uniq[uniq.length - 1]!) uniq.push(e);
  }
  return uniq;
}

/** Assign a value to a bin index given interior edges (binary-search-free; bins are small). */
function binIndex(value: number, edges: number[]): number {
  let i = 0;
  while (i < edges.length && value > edges[i]!) i++;
  return i; // 0 .. edges.length
}

/** Fraction of `samples` falling in each bin (length = edges.length + 1). */
function binFractions(samples: number[], edges: number[]): number[] {
  const counts = new Array<number>(edges.length + 1).fill(0);
  for (const v of samples) counts[binIndex(v, edges)]!++;
  const n = samples.length || 1;
  return counts.map((c) => c / n);
}

/**
 * PSI of `current` vs `baseline`. Returns 0 when either side is empty or the
 * baseline is constant (no distribution to shift away from). Always ≥ 0.
 */
export function computePSI(baseline: number[], current: number[], bins = DEFAULT_BINS): number {
  const base = baseline.filter((v) => Number.isFinite(v));
  const cur = current.filter((v) => Number.isFinite(v));
  if (base.length === 0 || cur.length === 0) return 0;

  const edges = baselineEdges(base, bins);
  if (edges.length === 0) return 0; // constant baseline → single bin → PSI 0

  const baseFrac = binFractions(base, edges);
  const curFrac = binFractions(cur, edges);

  let psi = 0;
  for (let i = 0; i < baseFrac.length; i++) {
    const b = Math.max(baseFrac[i]!, EPS);
    const c = Math.max(curFrac[i]!, EPS);
    psi += (c - b) * Math.log(c / b);
  }
  return psi < 0 ? 0 : psi;
}

export type FeaturePsi = Record<string, number>;

/** Max PSI across the monitored features (the meta-shift driver). */
export function maxPsi(byFeature: FeaturePsi): number {
  let m = 0;
  for (const v of Object.values(byFeature)) if (v > m) m = v;
  return m;
}

/** True iff any monitored feature has PSI above the meta-shift threshold. */
export function metaShiftDetected(byFeature: FeaturePsi, threshold = META_SHIFT_PSI_THRESHOLD): boolean {
  return maxPsi(byFeature) > threshold;
}
