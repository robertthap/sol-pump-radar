/**
 * Shared SOL price — cached fetch with static fallback for offline/dev.
 * Fetches USD (internal mcap math / gates) and AUD (user-facing display) together.
 */

export const SOL_USD_FALLBACK = 150;
/** Rough AUD fallback (≈ USD ÷ 0.65); only used offline until the first fetch. */
export const SOL_AUD_FALLBACK = 230;

const TTL_MS = 60_000;

let cache = { usd: SOL_USD_FALLBACK, aud: SOL_AUD_FALLBACK, at: 0 };

/** Synchronous USD price for hot paths (mcap math, gates). Refresh via getSolUsd(). */
export function getSolUsdSync(): number {
  return cache.usd;
}

/** Synchronous AUD price for display. Refresh via getSolUsd()/getSolAud(). */
export function getSolAudSync(): number {
  return cache.aud;
}

/** @deprecated Use getSolUsdSync() — kept for tests and gradual migration. */
export const SOL_USD = SOL_USD_FALLBACK;

/** Refresh both USD + AUD from CoinGecko (one call). Returns the USD price. */
export async function getSolUsd(): Promise<number> {
  const now = Date.now();
  if (now - cache.at < TTL_MS && cache.usd > 0) return cache.usd;

  try {
    const r = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd,aud",
      { headers: { accept: "application/json" }, cache: "no-store" },
    );
    if (r.ok) {
      const j = (await r.json()) as { solana?: { usd?: number; aud?: number } };
      const usd = j.solana?.usd;
      const aud = j.solana?.aud;
      if (usd != null && Number.isFinite(usd) && usd > 0) {
        cache = {
          usd,
          aud: aud != null && Number.isFinite(aud) && aud > 0 ? aud : cache.aud,
          at: now,
        };
        return usd;
      }
    }
  } catch {
    /* use last good or fallback */
  }

  if (cache.at === 0) cache = { usd: SOL_USD_FALLBACK, aud: SOL_AUD_FALLBACK, at: now };
  return cache.usd;
}

/** Live SOL→AUD price (ensures the shared cache is fresh first). */
export async function getSolAud(): Promise<number> {
  await getSolUsd();
  return cache.aud;
}

export function solPriceCacheSnapshot(): { usd: number; aud: number; ageMs: number } {
  return { usd: cache.usd, aud: cache.aud, ageMs: cache.at ? Date.now() - cache.at : 0 };
}

/** @deprecated Use solPriceCacheSnapshot(). */
export function solUsdCacheSnapshot(): { usd: number; ageMs: number } {
  return { usd: cache.usd, ageMs: cache.at ? Date.now() - cache.at : 0 };
}
