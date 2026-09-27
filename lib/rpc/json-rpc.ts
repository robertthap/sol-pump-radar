import "server-only";
import { rpcHttpUrls } from "@/lib/env";

/**
 * One Solana JSON-RPC call with endpoint failover: each configured HTTP endpoint
 * is tried in order (the Helius key's endpoint first when set, the public RPC as
 * fallback). Returns the `result`, or null when every endpoint failed or errored.
 * Never throws.
 */
export async function rpcCall<T>(method: string, params: unknown[], timeoutMs = 4_000): Promise<T | null> {
  for (const url of rpcHttpUrls()) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!r.ok) continue;
      const j = (await r.json()) as { result?: T; error?: unknown };
      if (j.error || j.result === undefined) continue;
      return j.result;
    } catch {
      /* try the next endpoint */
    }
  }
  return null;
}
