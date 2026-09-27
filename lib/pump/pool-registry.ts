import "server-only";
import { rpcCall } from "@/lib/rpc/json-rpc";
import {
  classifyPoolAccount,
  type PoolAccountResolution,
  type PoolAccountValue,
  type PoolInfo,
} from "./pool-account";

export type { PoolInfo } from "./pool-account";

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

const cache = new Map<string, PoolInfo | null>();

function cacheResolution(pool: string, resolution: PoolAccountResolution): PoolInfo | null {
  if (resolution.kind === "retry") return null;
  const info = resolution.kind === "resolved" ? resolution.info : null;
  cache.set(pool, info);
  return info;
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

  // Every configured endpoint, not just the first. This asked endpoint 0 alone,
  // so when the Helius key hit its quota (HTTP 429 "max usage reached") every
  // pool failed to resolve, every PumpSwap swap was dropped as an unresolved
  // pool, and `events` held zero venue='pumpswap' rows — with no error logged
  // anywhere, because a failure here is indistinguishable from "not a pool".
  const acc = await rpcCall<{ value: { data: [string, string]; owner: string } | null }>(
    "getAccountInfo",
    [pool, { encoding: "base64" }],
    5_000,
  );
  return cacheResolution(pool, classifyPoolAccount(acc?.value ?? null));
}

/** Batched resolution — resolves many pools, returning a map of the ones that
 *  succeeded. Unresolvable/failed pools are simply absent from the result. */
export async function resolvePoolInfoBatch(pools: string[]): Promise<Map<string, PoolInfo>> {
  const out = new Map<string, PoolInfo>();
  const unknown = [...new Set(pools)].filter((p) => !cache.has(p));
  // getMultipleAccounts accepts up to 100 addresses. One batched request replaces
  // dozens of individual getAccountInfo calls: the live firehose regularly has
  // 50-100 unseen pools in a flush, and the old 10-lane resolver took longer than
  // Graduation Scout's complete +1s..+5s observation window.
  const batches: string[][] = [];
  for (let i = 0; i < unknown.length; i += 100) batches.push(unknown.slice(i, i + 100));
  const LANES = 4;
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(LANES, batches.length) }, async () => {
      while (next < batches.length) {
        const batch = batches[next++]!;
        const response = await rpcCall<{ value: Array<PoolAccountValue | null> }>(
          "getMultipleAccounts",
          [batch, { encoding: "base64" }],
          2_000,
        );
        if (!response || !Array.isArray(response.value) || response.value.length !== batch.length) {
          continue; // transient RPC failure: leave every pool uncached for retry
        }
        for (let i = 0; i < batch.length; i++) {
          cacheResolution(batch[i]!, classifyPoolAccount(response.value[i] ?? null));
        }
      }
    }),
  );
  for (const p of pools) {
    const info = cache.get(p);
    if (info) out.set(p, info);
  }
  return out;
}

/** True when a missing batch result was transient and its raw swaps should be retried. */
export function isPoolResolutionPending(pool: string): boolean {
  return !cache.has(pool);
}
