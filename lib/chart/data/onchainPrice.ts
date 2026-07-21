import "server-only";

import bs58 from "bs58";
import { rpcHttpUrls } from "@/lib/env";
import { getSolUsd } from "@/lib/market/sol-usd";
import { PUMP_SUPPLY } from "@/lib/chart/constants";

/**
 * Real-time market cap straight from the PumpSwap pool's on-chain reserves via
 * Helius RPC. This reads the *current slot's* state — the same source DexScreener's
 * website uses — so it is genuinely live, unlike DexScreener's public REST API
 * (cached ~30-60s) or GeckoTerminal's OHLCV (~20s). Used for the live price line.
 *
 * PumpSwap pool account layout (after the 8-byte anchor discriminator):
 *   +0  pool_bump (u8)
 *   +1  index (u16)
 *   +3  creator (pubkey)
 *   +35 base_mint (pubkey)        → absolute offset 43
 *   +67 quote_mint (pubkey)       → absolute offset 75
 *   +99 lp_mint (pubkey)          → absolute offset 107
 *   +131 pool_base_token_account  → absolute offset 139  (base vault)
 *   +163 pool_quote_token_account → absolute offset 171  (quote vault)
 */

const WSOL = "So11111111111111111111111111111111111111112";

type PoolLayout = { memeVault: string; solVault: string };
// Pool vault addresses are immutable — cache forever. null = not a PumpSwap pool.
const layoutCache = new Map<string, PoolLayout | null>();

async function rpc<T>(method: string, params: unknown[]): Promise<T | null> {
  const url = rpcHttpUrls()[0];
  if (!url) return null;
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { result?: T };
    return j.result ?? null;
  } catch {
    return null;
  }
}

async function getPoolLayout(mint: string, pool: string): Promise<PoolLayout | null> {
  const cached = layoutCache.get(pool);
  if (cached !== undefined) return cached;

  const acc = await rpc<{ value: { data: [string, string] } | null }>("getAccountInfo", [
    pool,
    { encoding: "base64" },
  ]);
  const dataB64 = acc?.value?.data?.[0];
  if (!dataB64) {
    layoutCache.set(pool, null);
    return null;
  }
  const buf = Buffer.from(dataB64, "base64");
  if (buf.length < 203) {
    layoutCache.set(pool, null); // not a PumpSwap pool layout
    return null;
  }
  const pk = (off: number) => bs58.encode(buf.subarray(off, off + 32));
  const baseMint = pk(43);
  const quoteMint = pk(75);
  const baseVault = pk(139);
  const quoteVault = pk(171);

  // Identify which vault holds the meme token vs WSOL.
  let layout: PoolLayout | null = null;
  if (baseMint === mint && quoteMint === WSOL) layout = { memeVault: baseVault, solVault: quoteVault };
  else if (quoteMint === mint && baseMint === WSOL) layout = { memeVault: quoteVault, solVault: baseVault };

  layoutCache.set(pool, layout);
  return layout;
}

type ParsedTokenAcc = {
  data: { parsed: { info: { tokenAmount: { uiAmount: number | null } } } };
} | null;

/** Live market cap (USD) from the pool's current on-chain reserves, or null. */
export async function fetchOnchainMcap(mint: string, pool: string): Promise<number | null> {
  const layout = await getPoolLayout(mint, pool);
  if (!layout) return null;

  const ma = await rpc<{ value: ParsedTokenAcc[] }>("getMultipleAccounts", [
    [layout.memeVault, layout.solVault],
    { encoding: "jsonParsed" },
  ]);
  const memeAmt = ma?.value?.[0]?.data?.parsed?.info?.tokenAmount?.uiAmount;
  const solAmt = ma?.value?.[1]?.data?.parsed?.info?.tokenAmount?.uiAmount;
  if (!memeAmt || !solAmt || memeAmt <= 0 || solAmt <= 0) return null;

  // Use the async getter so the SOL price is actually refreshed (the sync getter
  // returns a $150 fallback until something calls getSolUsd() in this process,
  // which would skew the mcap ~2.2x). Cached 60s internally.
  const solUsd = await getSolUsd();
  if (!solUsd || solUsd <= 0) return null;

  // Constant-product spot price = quote(SOL) reserve / base(token) reserve.
  const priceUsd = (solAmt / memeAmt) * solUsd;
  return priceUsd * PUMP_SUPPLY;
}
