import "server-only";
import {
  fetchDexMarketBatch,
  type DexMarketSnapshot,
} from "@/lib/dex/market-snapshot";

const DEFAULT_TTL_MS = 12_000;

let cachedAt = 0;
let cachedMintsKey = "";
let cachedMarkets = new Map<string, DexMarketSnapshot>();

function mintsKey(mints: string[]): string {
  return [...new Set(mints)].sort().join(",");
}

/** Shared Dex batch fetch — dedupes continuation-universe + intelligence-commit API calls. */
export async function fetchDexMarketBatchCached(
  mints: string[],
  ttlMs = DEFAULT_TTL_MS,
): Promise<Map<string, DexMarketSnapshot>> {
  const key = mintsKey(mints);
  const now = Date.now();
  if (key === cachedMintsKey && now - cachedAt < ttlMs && cachedMarkets.size > 0) {
    const out = new Map<string, DexMarketSnapshot>();
    for (const m of mints) {
      const hit = cachedMarkets.get(m);
      if (hit) out.set(m, hit);
    }
    if (out.size > 0) return out;
  }

  const fresh = await fetchDexMarketBatch(mints);
  cachedAt = now;
  cachedMintsKey = key;
  cachedMarkets = fresh;
  return fresh;
}

export function invalidateDexMarketCache(): void {
  cachedAt = 0;
  cachedMintsKey = "";
  cachedMarkets = new Map();
}
