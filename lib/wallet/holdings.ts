import "server-only";
import { logger } from "@/lib/log";

const log = logger("wallet:holdings");

const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

type TokenAccount = {
  account: {
    data: {
      parsed: {
        info: {
          mint: string;
          tokenAmount: {
            amount: string;
            decimals: number;
            uiAmount: number | null;
            uiAmountString: string;
          };
        };
      };
    };
  };
  pubkey: string;
};

export type TokenBalance = {
  amount: bigint;
  uiAmount: number;
  decimals: number;
  account: string;
};

async function rpcCall<T>(rpcUrl: string, method: string, params: unknown[]): Promise<T> {
  const r = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!r.ok) throw new Error(`rpc ${method} HTTP ${r.status}`);
  const j = (await r.json()) as
    | { result: T }
    | { error: { code: number; message: string } };
  if ("error" in j) throw new Error(`rpc ${method}: ${j.error.message}`);
  return j.result;
}

/**
 * Returns the largest token account balance for (pubkey, mint), or null if the
 * user holds none. The largest-account heuristic is fine because pump.fun mints
 * never have multiple ATAs per owner in practice.
 */
export async function fetchTokenBalance(
  pubkey: string,
  mint: string,
  rpcUrl: string,
): Promise<TokenBalance | null> {
  try {
    const res = await rpcCall<{ value: TokenAccount[] }>(rpcUrl, "getTokenAccountsByOwner", [
      pubkey,
      { mint },
      { encoding: "jsonParsed" },
    ]);
    if (!res?.value?.length) return null;
    let best: TokenBalance | null = null;
    for (const acc of res.value) {
      const info = acc.account.data.parsed.info;
      const amount = BigInt(info.tokenAmount.amount);
      const uiAmount = info.tokenAmount.uiAmount ?? 0;
      if (!best || amount > best.amount) {
        best = {
          amount,
          uiAmount,
          decimals: info.tokenAmount.decimals,
          account: acc.pubkey,
        };
      }
    }
    return best;
  } catch (e) {
    log.warn("getTokenAccountsByOwner failed", { mint, err: String(e) });
    return null;
  }
}

export const TOKEN_PROGRAM = TOKEN_PROGRAM_ID;

/**
 * Fetches all SPL token holdings for an owner in one RPC call. Returns a Map
 * keyed by mint -> aggregated balance across all token accounts (for that mint).
 *
 * Much cheaper than calling `fetchTokenBalance` once per mint when you need to
 * reconcile a wallet's full holdings against many open trades.
 */
export async function fetchAllTokenBalances(
  pubkey: string,
  rpcUrl: string,
): Promise<Map<string, TokenBalance>> {
  try {
    const res = await rpcCall<{ value: TokenAccount[] }>(rpcUrl, "getTokenAccountsByOwner", [
      pubkey,
      { programId: TOKEN_PROGRAM_ID },
      { encoding: "jsonParsed" },
    ]);
    const out = new Map<string, TokenBalance>();
    if (!res?.value?.length) return out;
    for (const acc of res.value) {
      const info = acc.account.data.parsed.info;
      const amount = BigInt(info.tokenAmount.amount);
      const uiAmount = info.tokenAmount.uiAmount ?? 0;
      const existing = out.get(info.mint);
      if (existing) {
        existing.amount += amount;
        existing.uiAmount += uiAmount;
      } else {
        out.set(info.mint, {
          amount,
          uiAmount,
          decimals: info.tokenAmount.decimals,
          account: acc.pubkey,
        });
      }
    }
    return out;
  } catch (e) {
    log.warn("getTokenAccountsByOwner all failed", { err: String(e) });
    return new Map();
  }
}
