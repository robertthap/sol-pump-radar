import "server-only";

import type { Candle, ChartTimeframe } from "@/lib/chart/types";

/**
 * Real OHLCV candles for graduated (post-bonding-curve) tokens from GeckoTerminal
 * (CoinGecko's free public DEX API — the same data DexScreener renders). No key.
 *
 * Replaces the old quote-snapshot approach (a single priceUsd polled every 3 s),
 * which could only ever produce flat doji candles. GeckoTerminal returns true
 * open/high/low/close + volume per bucket, giving the dense continuous chart users
 * expect from DexScreener / TradingView.
 *
 * Returned prices are USD per token = unit price (close * 1e9 = market cap), the
 * same scale used everywhere else in the chart pipeline.
 */

const GT_BASE = "https://api.geckoterminal.com/api/v2";

type GtRes = "minute" | "hour" | "day";

// App timeframe → GeckoTerminal {resolution, aggregate}. GeckoTerminal's finest
// resolution is 1 minute, so sub-minute TFs fall back to 1 m (still far better
// than sparse snapshots; bonding-curve tokens keep real sub-minute trade candles).
const TF_TO_GT: Record<ChartTimeframe, { res: GtRes; aggregate: number }> = {
  "1s": { res: "minute", aggregate: 1 },
  "5s": { res: "minute", aggregate: 1 },
  "15s": { res: "minute", aggregate: 1 },
  "1m": { res: "minute", aggregate: 1 },
  "5m": { res: "minute", aggregate: 5 },
  "15m": { res: "minute", aggregate: 15 },
  "1h": { res: "hour", aggregate: 1 },
  "4h": { res: "hour", aggregate: 4 },
  "1D": { res: "day", aggregate: 1 },
};

type OhlcvTuple = [number, number, number, number, number, number];

// GeckoTerminal free tier allows ~30 calls/min. Cache per pool+resolution with a
// TTL scaled to how fast each resolution actually changes, and back off on errors
// (esp. 429) so a rate-limited response is served from stale cache instead of
// hammering the API. This keeps us comfortably under the limit for normal use.
const cache = new Map<string, { candles: Candle[]; nextFetchAt: number }>();

const TTL_BY_RES: Record<GtRes, number> = {
  minute: 20_000, // newest 1m bucket refreshes every 20 s
  hour: 90_000,
  day: 600_000,
};
const ERROR_BACKOFF_MS = 30_000;

// Serialize outbound calls with a minimum spacing so a burst of chart opens
// (switching between coins quickly) can never exceed the free-tier 30/min limit.
// ~2.2 s spacing → max ~27 calls/min. Cache hits bypass this entirely.
const MIN_CALL_INTERVAL_MS = 2_200;
let geckoChain: Promise<void> = Promise.resolve();
let lastCallAt = 0;

function scheduleGeckoCall<T>(fn: () => Promise<T>): Promise<T> {
  const result = geckoChain.then(async () => {
    const wait = MIN_CALL_INTERVAL_MS - (Date.now() - lastCallAt);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCallAt = Date.now();
    return fn();
  });
  geckoChain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/** Fetch real OHLCV candles for a pool. Cached + rate-limit aware. */
export async function fetchGeckoOhlcv(
  poolAddress: string,
  tf: ChartTimeframe,
  limit = 1000,
): Promise<Candle[]> {
  const m = TF_TO_GT[tf];
  const key = `${poolAddress}:${m.res}:${m.aggregate}`;
  const hit = cache.get(key);
  if (hit && Date.now() < hit.nextFetchAt) return hit.candles;

  // Queue behind the throttle. Re-check the cache after the wait — a concurrent
  // request for the same pool may have already refreshed it (request coalescing).
  return scheduleGeckoCall(() => doFetch(poolAddress, tf, key, m, limit));
}

async function doFetch(
  poolAddress: string,
  _tf: ChartTimeframe,
  key: string,
  m: { res: GtRes; aggregate: number },
  limit: number,
): Promise<Candle[]> {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now < hit.nextFetchAt) return hit.candles;

  const url =
    `${GT_BASE}/networks/solana/pools/${poolAddress}/ohlcv/${m.res}` +
    `?aggregate=${m.aggregate}&limit=${Math.min(1000, Math.max(1, limit))}&currency=usd`;

  try {
    const r = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
    });
    if (!r.ok) {
      // Rate-limited or unavailable — serve stale and back off before retrying.
      if (hit) {
        hit.nextFetchAt = now + ERROR_BACKOFF_MS;
        return hit.candles;
      }
      return [];
    }
    const j = (await r.json()) as {
      data?: { attributes?: { ohlcv_list?: OhlcvTuple[] } };
    };
    const list = j.data?.attributes?.ohlcv_list ?? [];
    if (!list.length) {
      if (hit) hit.nextFetchAt = now + ERROR_BACKOFF_MS;
      return hit?.candles ?? [];
    }

    const candles: Candle[] = list
      .map(
        ([t, o, h, l, c, v]): Candle => ({
          time: t,
          open: o,
          high: h,
          low: l,
          close: c,
          volume: Number.isFinite(v) ? v : 0,
          state: "final",
        }),
      )
      .filter((c) => c.time > 0 && c.close > 0 && c.high >= c.low)
      .sort((a, b) => a.time - b.time);

    // Mark the most recent bucket as still forming.
    if (candles.length) candles[candles.length - 1]!.state = "open";

    cache.set(key, { candles, nextFetchAt: now + TTL_BY_RES[m.res] });
    return candles;
  } catch {
    if (hit) {
      hit.nextFetchAt = now + ERROR_BACKOFF_MS;
      return hit.candles;
    }
    return [];
  }
}
