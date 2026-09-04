/**
 * Source-health flags stamped on every feature_snapshots row (no server-only — testable).
 *
 * Both sampling arms must emit the SAME shape. The universe arm and the control
 * arm exist to be compared, so if one records richer staleness than the other,
 * any filter written against those flags silently drops rows from one arm only —
 * which biases the very comparison the control arm exists to make unbiased.
 *
 * Takes the already-read source health rather than reading it, so the mapping
 * stays pure and unit-testable.
 */
import type { SolUsdFreshness } from "@/lib/market/sol-usd";

/** Beyond this age the cached DexScreener snapshot is treated as stale. */
export const DEX_STALE_MS = 90_000;

export type SnapshotStaleFlags = {
  sol_price_stale: boolean;
  sol_price_fallback: boolean;
  dex_age_ms: number | null;
  dex_stale: boolean;
};

export function snapshotStaleFlags(
  sol: SolUsdFreshness,
  dexAgeMs: number,
): SnapshotStaleFlags {
  return {
    sol_price_stale: !sol.fresh,
    sol_price_fallback: sol.usingFallback,
    // Infinity means "never fetched" — not a real age, so store null.
    dex_age_ms: Number.isFinite(dexAgeMs) ? dexAgeMs : null,
    dex_stale: dexAgeMs > DEX_STALE_MS,
  };
}
