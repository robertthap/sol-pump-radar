import "server-only";
import type { ScoredMint } from "@/lib/workers/analytics";
import type { MintFlags } from "@/lib/db/repos/bots";
import type { IntelligenceInputSnapshot, IntelligenceRiskFlags } from "@/lib/intelligence/types";
import type { RankInput } from "@/lib/continuation/cross-mint-rank";

import { getSolUsdSync } from "@/lib/market/sol-usd";
import { launchQualityScore, launchRankScore } from "@/lib/intelligence/launch-rank";
import { relaxedTierEnabled } from "@/lib/trade/tier-control";

/** Module score inputs — analytics ScoredMint or token_features fallback row. */
export type TokenFeatureModuleScores = {
  gradScore: number;
  insiderScore: number;
  rugScore: number;
  creatorScore: number;
  washScore: number;
  vSol?: number | null;
};

/** Curve-era snapshot for Engine A from analytics features. */
export function scoredMintToIntelligenceInput(s: ScoredMint): IntelligenceInputSnapshot {
  const f = s.features;
  const age = f.ageSeconds ?? 0;
  const vSol = f.currentVSol ?? 0;
  const v5 = f.vSol5mAgo ?? vSol;
  const velocity = vSol - v5;
  const vol5 = f.buyVol5m + f.sellVol5m;
  const vol30 = vol5 * 3;
  const pump = f.pumpMultiple ?? 1;

  return {
    mint: s.mint,
    age_seconds: age,
    liquidity_usd: Math.max(0, vSol * getSolUsdSync()),
    volume_m5: vol5,
    volume_m30: vol30,
    volume_h1: vol30 * 2,
    price_change_m1: velocity > 0 ? Math.min(30, velocity * 4) : 0,
    price_change_m5: velocity > 0 ? Math.min(40, velocity * 6) : 0,
    price_change_h1: (pump - 1) * 40,
    buy_sell_ratio:
      f.buys5m + f.sells5m > 0 ? f.buys5m / (f.buys5m + f.sells5m) : 0.5,
    unique_wallets_5m: f.uniqueBuyers5m,
    unique_wallets_30m: Math.max(f.uniqueBuyers5m, f.earlyUniqueBuyers),
    holder_growth: f.earlyUniqueBuyers > 0 ? Math.min(1, f.uniqueBuyers5m / f.earlyUniqueBuyers) : 0,
    pool_count: 1,
    dex_rank: null,
    is_new_pool: age < 300,
    migration_status: "curve",
  };
}

export function rankInputFromScoredMint(s: ScoredMint): RankInput {
  const f = s.features;
  const vol5 = f.buyVol5m + f.sellVol5m;
  const v5ago = f.vSol5mAgo ?? f.currentVSol ?? 1;
  const volAccel = v5ago > 0 && f.currentVSol != null ? (f.currentVSol - v5ago) / v5ago : 0;

  // A6 de-bias: the old rank `confluence·0.45 + grad·0.55` was ≈ pure graduation
  // progress (confluence itself ≈ grad − penalties), so fresh launches were ranked
  // below mature coins regardless of velocity. Blend in maturity-independent launch
  // quality so a fast fresh launch can out-rank a slow mature one. See launch-rank.ts.
  const launchQuality = launchQualityScore({
    velocity: volAccel,
    uniqueBuyers5m: f.uniqueBuyers5m,
    earlyUniqueBuyers: f.earlyUniqueBuyers,
    buys5m: f.buys5m,
    sells5m: f.sells5m,
  });
  // Profit-adaptive: lean into launches only while the loose/launch (relaxed) tier is
  // proving profitable. When the learner disables it (negative expectancy), drop the
  // launch tilt so the rank reverts to proven (confluence/continuation) signals —
  // "focus on profitable trades, not just new launches".
  const launchWeight = relaxedTierEnabled() ? 0.4 : 0.12;

  return {
    mint: s.mint,
    continuationScore: launchRankScore(s.confluenceScore, launchQuality, launchWeight),
    volAcceleration: Math.max(0, volAccel + vol5 * 0.01),
    weightedLiqUsd: Math.max(0, (f.currentVSol ?? 0) * getSolUsdSync()),
    priceChangeH24: (f.pumpMultiple ?? 1) * 50,
  };
}

export function riskFlagsFromScored(
  s: ScoredMint,
  flags?: MintFlags | null,
  rugLabel?: string,
): IntelligenceRiskFlags {
  const f = s.features;
  return {
    rug: s.rugScore >= 0.4 || rugLabel === "rugged",
    bundle: flags?.hasBundle ?? f.hasBundle,
    insider: s.insiderScore >= 0.58,
    rapid_sell_pressure: f.sells5m > f.buys5m * 1.5,
  };
}

/** M1–M5 keys consumed by entry-filter and decision_log analytics. */
export const VSOL_MODULE_KEY = "_v_sol";

export function moduleScoresFromScoredMint(s: ScoredMint): Record<string, number> {
  const scores = moduleScoresFromValues({
    gradScore: s.gradScore,
    insiderScore: s.insiderScore,
    rugScore: s.rugScore,
    creatorScore: s.creatorRiskScore,
    washScore: s.washScore,
    vSol: s.features.currentVSol ?? null,
  });
  return scores;
}

export function moduleScoresFromValues(v: TokenFeatureModuleScores): Record<string, number> {
  const scores: Record<string, number> = {
    M1_GRADUATION: v.gradScore,
    M2_INSIDER: v.insiderScore,
    M3_RUG: v.rugScore,
    M4_CREATOR: v.creatorScore,
    M5_WASH: v.washScore,
  };
  if (v.vSol != null && v.vSol > 0) scores[VSOL_MODULE_KEY] = v.vSol;
  return scores;
}