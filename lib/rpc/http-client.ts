import "server-only";
import type { RpcClient } from "@/lib/ingest/gap-recovery";

/**
 * T1.1 — minimal Solana JSON-RPC client for gap recovery. Wraps fetch() rather
 * than pulling in @solana/web3.js — keeps the gap-recovery path lean and easy
 * to mock in tests. Only implements the two methods the RpcClient interface
 * requires (getSignaturesForAddress, getTransaction).
 *
 * Discipline: never throws on a network error — returns empty results so the
 * caller's per-mint failure isolation can record a failed mint without
 * aborting the whole gap recovery.
 */

export function makeHttpRpcClient(httpUrl: string): RpcClient {
  let nextId = 1;
  async function rpcCall(method: string, params: unknown[]): Promise<unknown> {
    const body = JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params });
    try {
      const res = await fetch(httpUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      if (!res.ok) return null;
      const j = (await res.json()) as { result?: unknown; error?: unknown };
      if (j.error) return null;
      return j.result ?? null;
    } catch {
      return null;
    }
  }

  return {
    async getSignaturesForAddress(address, opts) {
      const params: [string, Record<string, unknown>] = [address, {}];
      if (opts?.before) params[1].before = opts.before;
      if (opts?.until) params[1].until = opts.until;
      if (opts?.limit != null) params[1].limit = opts.limit;
      const r = (await rpcCall("getSignaturesForAddress", params)) as
        | Array<{ signature: string; slot: number; blockTime: number | null }>
        | null;
      return Array.isArray(r) ? r : [];
    },

    async getTransaction(signature) {
      // maxSupportedTransactionVersion: 0 is required to receive versioned txs;
      // without it the server returns null for many post-mainnet upgrade txs.
      const r = (await rpcCall("getTransaction", [
        signature,
        { encoding: "json", maxSupportedTransactionVersion: 0 },
      ])) as {
        slot?: number;
        blockTime?: number | null;
        meta?: { logMessages?: string[] | null } | null;
      } | null;
      if (!r) return null;
      return {
        slot: r.slot ?? 0,
        blockTime: r.blockTime ?? null,
        meta: r.meta ? { logMessages: r.meta.logMessages ?? null } : null,
      };
    },
  };
}
