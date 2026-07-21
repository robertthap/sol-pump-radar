import "server-only";

import { fetchDexMarketBatchCached } from "@/lib/dex/snapshot-cache";

/** Pool addresses are immutable once a token graduates — cache them indefinitely. */
const poolByMint = new Map<string, string>();

/** Resolve the primary DEX pool (pair) address for a mint, for OHLCV lookups. */
export async function resolveDexPool(mint: string): Promise<string | null> {
  const cached = poolByMint.get(mint);
  if (cached) return cached;
  try {
    const markets = await fetchDexMarketBatchCached([mint]);
    const pool = markets.get(mint)?.primaryPool;
    if (pool) {
      poolByMint.set(mint, pool);
      return pool;
    }
  } catch {
    /* offline — caller falls back */
  }
  return null;
}
