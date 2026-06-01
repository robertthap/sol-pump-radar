import "server-only";
import type { IntelligenceInputSnapshot } from "@/lib/intelligence/types";
import type { NormalizedMintSnapshot } from "@/lib/continuation/types";

/** Map spec input → Engine B normalized snapshot. */
export function intelligenceInputToNormalized(
  input: IntelligenceInputSnapshot,
): NormalizedMintSnapshot {
  const volAccel =
    input.volume_m30 > 0
      ? input.volume_m5 / Math.max(input.volume_m30 / 6, 1)
      : input.volume_m5 > 0
        ? 2
        : 0;

  return {
    mint: input.mint,
    symbol: null,
    alignedTs: Date.now(),
    weightedLiqUsd: input.liquidity_usd,
    unifiedVol: {
      m5: input.volume_m5,
      h1: input.volume_h1,
      h24: input.volume_h1 * 4,
    },
    volAcceleration: volAccel,
    poolCount: input.pool_count,
    poolStabilityFactor: input.pool_count > 1 ? 1 : 0.85,
    primaryPool: input.mint,
    primaryDex: input.migration_status === "curve" ? null : "dex",
    priceChangeM5: input.price_change_m5,
    priceChangeH1: input.price_change_h1,
    priceChangeH24: input.price_change_h1 * 2,
    buysM5: Math.round(input.volume_m5 * input.buy_sell_ratio),
    sellsM5: Math.round(input.volume_m5 * (1 - input.buy_sell_ratio)),
    buySellRatio: input.buy_sell_ratio,
    singlePoolSpikeFlag: volAccel >= 2.5,
  };
}

export function engineAEligible(input: IntelligenceInputSnapshot): boolean {
  return (
    input.age_seconds < 600 ||
    input.is_new_pool ||
    (input.liquidity_usd > 10_000 && input.volume_m5 > input.volume_m30 * 0.15) ||
    (input.unique_wallets_5m > 8 && input.holder_growth > 0.05)
  );
}

export function engineBEligible(input: IntelligenceInputSnapshot): boolean {
  return (
    input.migration_status === "dex" ||
    input.migration_status === "graduated" ||
    input.dex_rank != null ||
    input.liquidity_usd >= 8_000
  );
}
