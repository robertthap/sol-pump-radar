import "server-only";

import { fetchPumpJson, PUMP_TRADE_TIMEOUT_MS } from "@/lib/pump/fetch-json";
import { BoundedMap } from "@/lib/shared/bounded-map";
import { effectiveVSolFromReserves } from "@/lib/pump/pumpswap-parser";

const BASE = "https://frontend-api-v3.pump.fun";
/** pump.fun bonding curve graduates around this SOL level */
export const PUMP_GRADUATION_SOL = 85;

export type PumpFunCoinRaw = {
  mint: string;
  name?: string;
  symbol?: string;
  description?: string;
  complete?: boolean;
  program?: string;
  protocol?: string;
  indexed_by_pump?: boolean;
  real_sol_reserves?: number;
  virtual_sol_reserves?: number;
  virtual_token_reserves?: number;
  real_quote_reserves?: number;
  virtual_quote_reserves?: number;
  market_cap?: number;
  usd_market_cap?: number;
  created_timestamp?: number;
  last_trade_timestamp?: number;
  is_banned?: boolean;
  image_uri?: string;
  twitter?: string;
  telegram?: string;
  website?: string;
  creator?: string;
  reply_count?: number;
  raydium_pool?: string;
  ath_market_cap?: number;
};

export type PumpFunCoin = {
  mint: string;
  name: string | null;
  symbol: string | null;
  complete: boolean;
  vSol: number | null;
  usdMarketCap: number | null;
  createdAt: string | null;
  lastTradeAt: string | null;
  onPump: boolean;
  imageUri: string | null;
  twitter: string | null;
  telegram: string | null;
  website: string | null;
  creator: string | null;
  replyCount: number;
  raydiumPool: string | null;
  athMarketCap: number | null;
  bondingPct: number | null;
};

export function isPumpFunCoin(c: PumpFunCoinRaw): boolean {
  if (c.is_banned) return false;
  if (c.program === "pump" || c.protocol === "pump") return true;
  if (c.indexed_by_pump) return true;
  if (c.mint.endsWith("pump")) return true;
  return false;
}

/**
 * Curve-equivalent vSol from the API's VIRTUAL reserves (price = virtual SOL /
 * virtual tokens), converted the same way as the on-chain paths (lib/pump/parser,
 * lib/pricing/live-price). The previous version returned the REAL SOL reserve
 * first — 0-85 SOL, a different scale from the virtual 30-115 every consumer
 * expects — and trend-scanner wrote that into events.v_sol_after.
 */
export function pumpFunVSol(c: PumpFunCoinRaw): number | null {
  if (c.virtual_sol_reserves == null || c.virtual_token_reserves == null) return null;
  return effectiveVSolFromReserves(c.virtual_sol_reserves / 1e9, c.virtual_token_reserves);
}

/** Bonding progress from the REAL SOL reserve, which is what reaches ~85 SOL at graduation. */
function bondingPct(realSol: number | null, complete: boolean): number | null {
  if (complete) return 100;
  if (realSol == null) return null;
  return Math.min(100, (realSol / PUMP_GRADUATION_SOL) * 100);
}

function normalize(c: PumpFunCoinRaw): PumpFunCoin {
  const vSol = pumpFunVSol(c);
  const realSol = c.real_sol_reserves != null ? c.real_sol_reserves / 1e9 : null;
  const complete = Boolean(c.complete);
  return {
    mint: c.mint,
    name: c.name ?? null,
    symbol: c.symbol ?? null,
    complete,
    vSol,
    usdMarketCap: c.usd_market_cap ?? c.market_cap ?? null,
    createdAt: c.created_timestamp ? new Date(c.created_timestamp).toISOString() : null,
    lastTradeAt: c.last_trade_timestamp ? new Date(c.last_trade_timestamp).toISOString() : null,
    onPump: isPumpFunCoin(c),
    imageUri: c.image_uri ?? null,
    twitter: c.twitter ?? null,
    telegram: c.telegram ?? null,
    website: c.website ?? null,
    creator: c.creator ?? null,
    replyCount: c.reply_count ?? 0,
    raydiumPool: c.raydium_pool ?? null,
    athMarketCap: c.ath_market_cap ?? null,
    bondingPct: bondingPct(realSol, complete),
  };
}

// Short TTL cache for single-coin lookups. The worker now resolves the live mcap
// for every open position each exit tick (plus once at entry); without this the
// pump API gets hammered and rate-limits to nulls. 8s is fresh enough for mcap
// display/exit, and we serve the last good value on a transient error.
// Bounded, oldest-evicted: the old cache cleared EVERY entry once it reached its
// cap, so a busy entry scan wiped the values open positions were being served from.
const coinCache = new BoundedMap<string, { coin: PumpFunCoin | null; ts: number }>(1_000);
const COIN_CACHE_TTL_MS = 8_000;
/** How long a last-good coin may stand in for failed or unusable responses. */
const COIN_STALE_MAX_MS = 60_000;

export async function fetchPumpFunCoin(mint: string): Promise<PumpFunCoin | null> {
  const cached = coinCache.get(mint);
  const now = Date.now();
  if (cached && now - cached.ts < COIN_CACHE_TTL_MS) return cached.coin;
  const lastGood = cached?.coin != null && now - cached.ts < COIN_STALE_MAX_MS ? cached.coin : null;
  try {
    const raw = await fetchPumpJson<PumpFunCoinRaw>(
      `${BASE}/coins/${encodeURIComponent(mint)}`,
      PUMP_TRADE_TIMEOUT_MS,
    );
    if (!isPumpFunCoin(raw)) {
      // An unusable body for a coin we just had (rate-limit or error payload with a
      // 200) must not replace the good value with null.
      if (lastGood) return lastGood;
      coinCache.set(mint, { coin: null, ts: now });
      return null;
    }
    const coin = normalize(raw);
    coinCache.set(mint, { coin, ts: now });
    return coin;
  } catch {
    // Serve the last good value through transient errors/rate limits, for a bounded
    // time, rather than null-flapping.
    return lastGood;
  }
}

export async function fetchPumpFunCoins(opts?: {
  limit?: number;
  offset?: number;
  sort?: "last_trade_timestamp" | "created_timestamp" | "market_cap";
  order?: "ASC" | "DESC";
  timeoutMs?: number;
}): Promise<PumpFunCoin[]> {
  const limit = Math.min(100, Math.max(1, opts?.limit ?? 50));
  const offset = Math.max(0, opts?.offset ?? 0);
  const sort = opts?.sort ?? "last_trade_timestamp";
  const order = opts?.order ?? "DESC";
  const qs = new URLSearchParams({
    offset: String(offset),
    limit: String(limit),
    sort,
    order,
    includeNsfw: "false",
  });
  const raw = await fetchPumpJson<PumpFunCoinRaw[]>(
    `${BASE}/coins?${qs}`,
    opts?.timeoutMs,
  );
  return raw.filter(isPumpFunCoin).map(normalize);
}

export type TrenchesFeed = {
  new: PumpFunCoin[];
  almostBonded: PumpFunCoin[];
  migrated: PumpFunCoin[];
};

/** Single pump.fun list call — faster than dual fetch. */
export async function fetchTrenchesFeed(): Promise<TrenchesFeed> {
  const batch = await fetchPumpFunCoins({
    limit: 40,
    sort: "last_trade_timestamp",
    order: "DESC",
  });

  const onCurve = batch.filter((c) => !c.complete);
  const migrated = batch
    .filter((c) => c.complete)
    .sort((a, b) => {
      const ta = a.lastTradeAt ? Date.parse(a.lastTradeAt) : 0;
      const tb = b.lastTradeAt ? Date.parse(b.lastTradeAt) : 0;
      return tb - ta;
    })
    .slice(0, 24);

  const fresh = onCurve
    .sort((a, b) => {
      const ta = a.createdAt ? Date.parse(a.createdAt) : 0;
      const tb = b.createdAt ? Date.parse(b.createdAt) : 0;
      return tb - ta;
    })
    .slice(0, 24);

  const almostBonded = onCurve
    .filter((c) => (c.bondingPct ?? 0) >= 55)
    .sort((a, b) => (b.bondingPct ?? 0) - (a.bondingPct ?? 0))
    .slice(0, 24);

  return { new: fresh, almostBonded, migrated };
}

export async function searchPumpFunCoins(query: string, limit = 30): Promise<PumpFunCoin[]> {
  const q = query.trim();
  if (!q) return [];

  if (q.length >= 32 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(q)) {
    const one = await fetchPumpFunCoin(q);
    return one ? [one] : [];
  }

  const needle = q.toLowerCase();
  const batch = await fetchPumpFunCoins({ limit: 100, sort: "market_cap", order: "DESC" });
  return batch
    .filter(
      (c) =>
        c.symbol?.toLowerCase().includes(needle) ||
        c.name?.toLowerCase().includes(needle) ||
        c.mint.toLowerCase().includes(needle),
    )
    .slice(0, limit);
}
