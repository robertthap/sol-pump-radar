import bs58 from "bs58";
import { PUMP_SWAP_AMM_PROGRAM, WSOL_MINT } from "./program";

export type PoolInfo = { memeMint: string; baseIsWsol: boolean };

export type PoolAccountValue = {
  data: [string, string];
  owner: string;
};

export type PoolAccountResolution =
  | { kind: "resolved"; info: PoolInfo }
  | { kind: "negative" }
  | { kind: "retry" };

/**
 * Classify one PumpSwap pool account response.
 *
 * `retry` is deliberately distinct from a definitive negative result. A newly
 * created graduation pool can briefly be missing or shorter than its final
 * layout; caching that as negative would discard the exact first swaps the
 * Graduation Scout needs.
 */
export function classifyPoolAccount(value: PoolAccountValue | null): PoolAccountResolution {
  const dataB64 = value?.data?.[0];
  if (!value || !dataB64) return { kind: "retry" };
  if (value.owner !== PUMP_SWAP_AMM_PROGRAM) return { kind: "negative" };

  const buf = Buffer.from(dataB64, "base64");
  if (buf.length < 107) return { kind: "retry" };

  const baseMint = bs58.encode(buf.subarray(43, 75));
  const quoteMint = bs58.encode(buf.subarray(75, 107));
  if (baseMint === WSOL_MINT) {
    return { kind: "resolved", info: { memeMint: quoteMint, baseIsWsol: true } };
  }
  if (quoteMint === WSOL_MINT) {
    return { kind: "resolved", info: { memeMint: baseMint, baseIsWsol: false } };
  }
  return { kind: "negative" };
}
