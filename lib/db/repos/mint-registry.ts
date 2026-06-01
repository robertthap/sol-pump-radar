import "server-only";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import type { DexMarketSnapshot } from "@/lib/dex/market-snapshot";

export async function upsertMintRegistry(
  snap: DexMarketSnapshot,
  source: string,
): Promise<void> {
  const lifecycle =
    snap.migrationAgeHours != null && snap.migrationAgeHours > 2
      ? "migrated"
      : "active";
  await getDb().execute(sql`
    INSERT INTO mint_registry (
      mint, symbol, name, engine_origin, lifecycle_state, migration_at,
      primary_pool, primary_dex, pool_count, updated_at
    )
    VALUES (
      ${snap.mint},
      ${snap.symbol},
      ${snap.name},
      ${source},
      ${lifecycle},
      ${snap.pairCreatedAt?.toISOString() ?? null},
      ${snap.primaryPool},
      ${snap.primaryDex},
      ${snap.poolCount},
      now()
    )
    ON CONFLICT (mint) DO UPDATE SET
      symbol = COALESCE(EXCLUDED.symbol, mint_registry.symbol),
      name = COALESCE(EXCLUDED.name, mint_registry.name),
      lifecycle_state = EXCLUDED.lifecycle_state,
      migration_at = COALESCE(EXCLUDED.migration_at, mint_registry.migration_at),
      primary_pool = EXCLUDED.primary_pool,
      primary_dex = EXCLUDED.primary_dex,
      pool_count = EXCLUDED.pool_count,
      updated_at = now()
  `);
}

export async function upsertPoolRegistry(snap: DexMarketSnapshot): Promise<void> {
  for (const p of snap.pools) {
    await getDb().execute(sql`
      INSERT INTO pool_registry (mint, pair_address, dex_id, liq_usd, price_usd, updated_at)
      VALUES (${snap.mint}, ${p.pairAddress}, ${p.dexId}, ${p.liqUsd}, ${p.priceUsd}, now())
      ON CONFLICT (mint, pair_address) DO UPDATE SET
        dex_id = EXCLUDED.dex_id,
        liq_usd = EXCLUDED.liq_usd,
        price_usd = EXCLUDED.price_usd,
        updated_at = now()
    `);
  }
}
