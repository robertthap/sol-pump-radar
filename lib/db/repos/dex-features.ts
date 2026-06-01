import "server-only";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import type { DexMarketSnapshot } from "@/lib/dex/market-snapshot";
import type { ContinuationScoreResult } from "@/lib/continuation/score";

export async function upsertDexFeatures(
  snap: DexMarketSnapshot,
  scored: ContinuationScoreResult,
): Promise<void> {
  await getDb().execute(sql`
    INSERT INTO dex_features (
      mint, vol_m5, vol_h1, vol_h24, vol_acceleration, liq_usd, liq_growth_proxy,
      buys_m5, sells_m5, buy_sell_ratio, pool_count, price_change_m5, price_change_h1,
      price_change_h24, pair_created_at, migration_age_hours, continuation_score,
      exhaustion_risk, updated_at
    )
    VALUES (
      ${snap.mint},
      ${snap.volM5},
      ${snap.volH1},
      ${snap.volH24},
      ${snap.volAcceleration},
      ${snap.liqUsd},
      ${snap.volAcceleration},
      ${snap.buysM5},
      ${snap.sellsM5},
      ${snap.buySellRatio},
      ${snap.poolCount},
      ${snap.priceChangeM5},
      ${snap.priceChangeH1},
      ${snap.priceChangeH24},
      ${snap.pairCreatedAt?.toISOString() ?? null},
      ${snap.migrationAgeHours},
      ${scored.continuationScore},
      ${scored.exhaustionRisk},
      now()
    )
    ON CONFLICT (mint) DO UPDATE SET
      vol_m5 = EXCLUDED.vol_m5,
      vol_h1 = EXCLUDED.vol_h1,
      vol_h24 = EXCLUDED.vol_h24,
      vol_acceleration = EXCLUDED.vol_acceleration,
      liq_usd = EXCLUDED.liq_usd,
      buys_m5 = EXCLUDED.buys_m5,
      sells_m5 = EXCLUDED.sells_m5,
      buy_sell_ratio = EXCLUDED.buy_sell_ratio,
      pool_count = EXCLUDED.pool_count,
      price_change_m5 = EXCLUDED.price_change_m5,
      price_change_h1 = EXCLUDED.price_change_h1,
      price_change_h24 = EXCLUDED.price_change_h24,
      migration_age_hours = EXCLUDED.migration_age_hours,
      continuation_score = EXCLUDED.continuation_score,
      exhaustion_risk = EXCLUDED.exhaustion_risk,
      updated_at = now()
  `);
}

export type DexFeatureRow = {
  mint: string;
  continuationScore: number;
  exhaustionRisk: number;
  liqUsd: number;
  priceChangeH24: number | null;
  volH24: number;
};

export async function fetchDexFeature(mint: string): Promise<DexFeatureRow | null> {
  const res = await getDb().execute(sql`
    SELECT mint, continuation_score, exhaustion_risk, liq_usd, price_change_h24, vol_h24
    FROM dex_features WHERE mint = ${mint}
  `);
  const r = (res as unknown as {
    rows: Array<{
      mint: string;
      continuation_score: number;
      exhaustion_risk: number;
      liq_usd: number;
      price_change_h24: number | null;
      vol_h24: number;
    }>;
  }).rows[0];
  if (!r) return null;
  return {
    mint: r.mint,
    continuationScore: r.continuation_score,
    exhaustionRisk: r.exhaustion_risk,
    liqUsd: r.liq_usd,
    priceChangeH24: r.price_change_h24,
    volH24: r.vol_h24,
  };
}
