import "server-only";
import { logger } from "@/lib/log";

const log = logger("wallet:balance");

type RpcSuccess<T> = { jsonrpc: "2.0"; id: number | string; result: T };
type RpcError = { jsonrpc: "2.0"; id: number | string; error: { code: number; message: string } };

async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!r.ok) throw new Error(`rpc ${method} HTTP ${r.status}`);
  const j = (await r.json()) as RpcSuccess<T> | RpcError;
  if ("error" in j) throw new Error(`rpc ${method}: ${j.error.message}`);
  return j.result;
}

/**
 * Returns SOL balance (full SOL units, not lamports) for the given pubkey.
 * Uses raw RPC POST so we avoid hauling in @solana/web3.js Connection here.
 */
export async function fetchSolBalance(pubkey: string, rpcUrl: string): Promise<number> {
  try {
    const res = await rpc<{ value: number } | number>(rpcUrl, "getBalance", [pubkey]);
    const lamports = typeof res === "number" ? res : res.value;
    return lamports / 1_000_000_000;
  } catch (e) {
    log.warn("getBalance failed", { err: String(e) });
    return 0;
  }
}
