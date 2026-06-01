/**
 * Shared tuning-limit constants & clamps.
 *
 * The learner ({@link file://../workers/learner.ts}) may propose threshold/floor
 * overrides; these helpers bound how far a learned value may drift from its
 * preset default so a runaway loop can never open the gates arbitrarily wide.
 * Pure module (no server-only) so it is usable from pure scoring code and tests.
 */

/** Max absolute deviation for [0..1] thresholds (rank/score floors). */
export const MAX_DEVIATION_FROM_PRESET = 0.15;

/** Default fractional band for absolute values (e.g. USD liquidity floors). */
export const MAX_FRACTION_FROM_PRESET = 0.5;

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Clamp a learned [0..1] threshold to within `maxDev` of its preset `base`,
 * and to the [0,1] range overall.
 */
export function clampToDeviation(
  value: number,
  base: number,
  maxDev: number = MAX_DEVIATION_FROM_PRESET,
): number {
  if (!Number.isFinite(value)) return base;
  return clamp(value, Math.max(0, base - maxDev), Math.min(1, base + maxDev));
}

/**
 * Clamp a learned absolute value (e.g. liquidity floor in USD) to within a
 * fractional band of its preset `base`. Never returns below 0.
 */
export function clampToFraction(
  value: number,
  base: number,
  frac: number = MAX_FRACTION_FROM_PRESET,
): number {
  if (!Number.isFinite(value)) return base;
  return clamp(value, Math.max(0, base * (1 - frac)), base * (1 + frac));
}
