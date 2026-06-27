import "server-only";
import bs58 from "bs58";
import { rpcHttpUrls } from "@/lib/env";
import { WSOL_MINT } from "./program";

/**
 * T1.2 — PumpSwap pool → mint resolver. The swap event carries the pool address
 * but NOT the base/quote mints, so we read them from the pool account (immutable
 * after creation → cache forever). Mirrors lib/chart/data/onchainPrice.ts's
 * getPoolLayout but returns the mint identity the ingestor needs to map
 * base/quote → SOL/meme and resolve the user's side.
 *
 * Pool account layout (after 8-byte anchor discriminator):
 *   base_mint  @ absolute offset 43 (32 bytes)
 *   quote_mint @ absolute offset 75 (32 bytes)
 */

export type PoolInfo = { memeMint: string; baseIsWsol: boolean };

const cache = new Map<string, PoolInfo | null>();

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

/**
 * Resolve a PumpSwap pool to {memeMint, baseIsWsol}. Cached forever (pools are
 * immutable). null = not resolvable (not a PumpSwap pool, RPC failure, or a
 * pool with neither side WSOL — which we can't price in SOL). On RPC failure we
 * cache nothing so a later call can retry.
 */
export async function resolvePoolInfo(pool: string): Promise<PoolInfo | null> {
  const cached = cache.get(pool);
  if (cached !== undefined) return cached;

  const acc = await rpc<{ value: { data: [string, string] } | null }>("getAccountInfo", [
    pool,
    { encoding: "base64" },
  ]);
  const dataB64 = acc?.value?.data?.[0];
  if (!dataB64) {
    // RPC failure or missing account — don't cache, allow retry.
    return null;
  }
  const buf = Buffer.from(dataB64, "base64");
  if (buf.length < 107) {
    cache.set(pool, null); // not a PumpSwap pool layout — cache the negative
    return null;
  }
  const baseMint = bs58.encode(buf.subarray(43, 75));
  const quoteMint = bs58.encode(buf.subarray(75, 107));
  let info: PoolInfo | null = null;
  if (baseMint === WSOL_MINT) info = { memeMint: quoteMint, baseIsWsol: true };
  else if (quoteMint === WSOL_MINT) info = { memeMint: baseMint, baseIsWsol: false };
  // else: neither side is WSOL → can't price in SOL; info stays null (cached).
  cache.set(pool, info);
  return info;
}

/** Batched resolution — resolves many pools, returning a map of the ones that
 *  succeeded. Unresolvable/failed pools are simply absent from the result. */
export async function resolvePoolInfoBatch(pools: string[]): Promise<Map<string, PoolInfo>> {
  const out = new Map<string, PoolInfo>();
  const unknown = [...new Set(pools)].filter((p) => !cache.has(p));
  // Resolve unknowns (sequentially — pool resolution is one-time per pool and
  // rare; a graduated-coin session sees a bounded set of pools).
  for (const p of unknown) {
    await resolvePoolInfo(p).catch(() => null);
  }
  for (const p of pools) {
    const info = cache.get(p);
    if (info) out.set(p, info);
  }
  return out;
}
