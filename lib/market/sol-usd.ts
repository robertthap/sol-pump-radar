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
      { headers: { accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(5_000) },
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

/** Beyond this age the cached SOL price is treated as stale (3× the refresh TTL). */
export const SOL_USD_STALE_MS = TTL_MS * 3;

export type SolUsdFreshness = {
  usd: number;
  ageMs: number;
  /** False until the first successful (or attempted) fetch — i.e. still the $150 fallback. */
  everFetched: boolean;
  /** True when the price is the static fallback, never refreshed in this process. */
  usingFallback: boolean;
  /** Safe to use for pricing decisions / training labels. */
  fresh: boolean;
};

/**
 * Source-health for the SOL/USD rate (upgrade-plan Phase 0, issue #4). Callers
 * that mark trades or build training labels can flag/reject a stale or
 * never-fetched (fallback) price instead of silently using the wrong value —
 * the failure mode behind the historical 2.24× mcap mismark.
 */
export function solUsdFreshness(): SolUsdFreshness {
  const everFetched = cache.at > 0;
  const ageMs = everFetched ? Date.now() - cache.at : Infinity;
  return {
    usd: cache.usd,
    ageMs,
    everFetched,
    usingFallback: !everFetched,
    fresh: everFetched && ageMs < SOL_USD_STALE_MS,
  };
}

/** @deprecated Use solPriceCacheSnapshot(). */
export function solUsdCacheSnapshot(): { usd: number; ageMs: number } {
  return { usd: cache.usd, ageMs: cache.at ? Date.now() - cache.at : 0 };
}
