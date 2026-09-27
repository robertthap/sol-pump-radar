/**
 * Live trade settlement rules (PURE — no IO). The IO lane is
 * lib/workers/live-settlement.ts.
 *
 * A live buy or sell is only a fact once its transaction is confirmed on-chain.
 * Until then it is pending: a buy holds no tokens, a sell has realized nothing.
 * These rules decide, from a signature status, whether to wait, read the
 * transaction, or declare the trade failed; and turn a confirmed fill into the
 * numbers that get booked.
 */
import type { SwapFill } from "@/lib/executor/swap-fill";
import { effectiveVSolFromPriceSol } from "@/lib/pump/onchain-accounts";

/**
 * A transaction not seen this long after sending will never land: its blockhash
 * (valid ~150 blocks, roughly 60-90 s) has expired. Generous on purpose — calling
 * a trade failed that later lands would leave tokens unmanaged.
 */
export const SETTLE_TIMEOUT_MS = 120_000;

export type SignatureStatus =
  | { found: false }
  | { found: true; err: unknown; confirmationStatus: string | null };

export type SettlementStep =
  | { step: "wait"; reason: string }
  | { step: "read_transaction" }
  | { step: "failed"; reason: string };

/** `status` null means the status lookup itself failed (RPC down): always wait. */
export function decideSettlement(status: SignatureStatus | null, sentAtMs: number, nowMs: number): SettlementStep {
  if (status == null) return { step: "wait", reason: "status lookup failed" };
  if (!status.found) {
    return Number.isFinite(sentAtMs) && nowMs - sentAtMs > SETTLE_TIMEOUT_MS
      ? { step: "failed", reason: `not confirmed within ${SETTLE_TIMEOUT_MS / 1000}s (dropped or expired)` }
      : { step: "wait", reason: "not seen yet" };
  }
  if (status.err != null) return { step: "failed", reason: `failed on-chain: ${JSON.stringify(status.err)}` };
  if (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized") {
    return { step: "read_transaction" };
  }
  return { step: "wait", reason: `status ${status.confirmationStatus ?? "unknown"}` };
}

export type BuyBooking = {
  /** Entry price on the vSol scale — the same basis live exits are priced on. */
  entryVSol: number;
  /** All-in SOL spent: the P&L cost basis. */
  costSol: number;
  tokensRaw: bigint;
  feeSol: number;
};

export function bookBuy(fill: SwapFill): BuyBooking | null {
  if (fill.side !== "buy") return null;
  const entryVSol = effectiveVSolFromPriceSol(fill.priceSol);
  if (entryVSol == null) return null;
  return {
    entryVSol,
    costSol: fill.allInLamports / 1e9,
    tokensRaw: fill.tokensRaw,
    feeSol: fill.feeLamports / 1e9,
  };
}

export type SellBooking = {
  exitVSol: number;
  /** All-in SOL received by this sell (negative for a dust sale the fee outweighed). */
  proceedsSol: number;
  /** Share of the original position this sell disposed of, in (0, 1]. */
  fractionSold: number;
  /** Realized on this leg: proceeds minus the matching share of the cost basis. */
  realizedSol: number;
  feeSol: number;
};

/**
 * @param costSol       all-in cost of the buy (confirmed fill, or the requested size when unknown)
 * @param boughtTokensRaw tokens the buy delivered, when known; the sold share is then exact
 * @param requestedPct  percent of the remaining balance the sell asked for (fallback share)
 */
export function bookSell(i: {
  fill: SwapFill;
  costSol: number;
  boughtTokensRaw: bigint | null;
  requestedPct: number;
}): SellBooking | null {
  if (i.fill.side !== "sell") return null;
  const exitVSol = effectiveVSolFromPriceSol(i.fill.priceSol);
  if (exitVSol == null) return null;
  const fractionSold =
    i.boughtTokensRaw != null && i.boughtTokensRaw > 0n
      ? Math.min(1, Number(i.fill.tokensRaw) / Number(i.boughtTokensRaw))
      : Math.min(1, Math.max(0, i.requestedPct / 100));
  const proceedsSol = i.fill.allInLamports / 1e9;
  return {
    exitVSol,
    proceedsSol,
    fractionSold,
    realizedSol: proceedsSol - i.costSol * fractionSold,
    feeSol: i.fill.feeLamports / 1e9,
  };
}

/** Final P&L of a position: everything received across its sells, minus what it cost. */
export function finalPnlSol(i: { costSol: number; proceedsSolTotal: number }): number {
  return i.proceedsSolTotal - i.costSol;
}
