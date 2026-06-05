/**
 * A6 maturity de-bias (PURE — no server-only, unit-testable).
 *
 * The auto-trader's "buy quality" signals are all rooted in `gradScore`
 * (M1_GRADUATION = how close a coin is to graduating), which is a MATURITY proxy:
 *   - confluenceScore ≈ gradScore − risk_penalties        (lib/workers/analytics.ts)
 *   - Engine-A cross-mint rank ≈ confluence·0.45 + grad·0.55 ≈ grad − 0.45·penalties
 *   - the confluence floor gate rejects below ~0.36–0.56     (lib/trade/entry-filter.ts)
 * So a FRESH launch — which by definition has low graduation progress — is
 * structurally ranked below (and gated out beneath) mature/near-graduation coins
 * regardless of how fast it is actually moving. That is the root cause of
 * "it trades high-mcap coins, not fresh launches".
 *
 * `launchQualityScore` is a MATURITY-INDEPENDENT [0,1] quality signal built only
 * from velocity + organic buyer growth + buy pressure — none of which reward
 * maturity. Blending it into the rank/floor lets a fast fresh launch compete with
 * a slow mature coin instead of being buried by its low graduation progress. The
 * launch tier's velocity/liquidity/risk floors (L2.1/2.3, gate-config) still bound
 * quality, so this surfaces fresh launches without admitting junk.
 */

export function clamp01(x: number): number {
  return Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0;
}

export type LaunchQualityInput = {
  /** Liquidity (vSol) growth fraction over the recent window, e.g. 0.5 = +50%. */
  velocity: number | null | undefined;
  /** Distinct buyers in the last 5m. */
  uniqueBuyers5m: number | null | undefined;
  /** Early/baseline buyer cohort to measure growth against; omit → absolute scale. */
  earlyUniqueBuyers?: number | null | undefined;
  buys5m: number | null | undefined;
  sells5m: number | null | undefined;
};

/**
 * Maturity-independent launch quality in [0,1]: velocity (0.45) + buyer growth
 * (0.35) + buy pressure (0.20). Weights mirror the launch-velocity model (L2.1),
 * where liquidity growth + buy velocity are the strongest sustained-liquidity
 * predictors. Robust to missing inputs (treated as neutral/zero).
 */
export function launchQualityScore(i: LaunchQualityInput): number {
  // +100% liquidity over the window → 1.0 (negative/flat → 0).
  const velocity = clamp01(i.velocity ?? 0);

  const buyers = i.uniqueBuyers5m ?? 0;
  const early = i.earlyUniqueBuyers ?? 0;
  // Growth vs the early cohort when known; else absolute (≈8 buyers → 1.0).
  const buyerScore = early > 0 ? clamp01(buyers / early) : clamp01(buyers / 8);

  const total = (i.buys5m ?? 0) + (i.sells5m ?? 0);
  // 50% buys → 0 ; ≥85% buys → 1.0.
  const buyPressure = total > 0 ? clamp01(((i.buys5m ?? 0) / total - 0.5) / 0.35) : 0.5;

  return clamp01(0.45 * velocity + 0.35 * buyerScore + 0.2 * buyPressure);
}

/**
 * Engine-A cross-mint rank score: a blend of (graduation-based) confluence and
 * maturity-independent launch quality, so a fast fresh launch can out-rank a slow
 * mature coin instead of being buried by low graduation progress. Replaces the old
 * `confluence·0.45 + gradScore·0.55` (which was ≈ pure graduation progress).
 *
 * `launchWeight` ∈ [0, 0.5] is how much the launch-quality tilt counts (the rest is
 * confluence). Callers should LOWER it when fresh launches are not currently
 * profitable, so the system focuses on proven signals rather than dogmatically
 * chasing launches (see scored-mint-adapter, gated on the learner's relaxed-tier
 * profitability flag). Default 0.35 is a conservative tilt — confluence still leads.
 */
export function launchRankScore(
  confluenceScore: number,
  launchQuality: number,
  launchWeight = 0.35,
): number {
  const w = Math.max(0, Math.min(0.5, Number.isFinite(launchWeight) ? launchWeight : 0.35));
  return clamp01(confluenceScore) * (1 - w) + clamp01(launchQuality) * w;
}
