import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  SETTLE_TIMEOUT_MS,
  bookBuy,
  bookSell,
  decideSettlement,
  finalPnlSol,
} from "@/lib/executor/live-settlement-core";
import type { SwapFill } from "@/lib/executor/swap-fill";

const T0 = 1_000_000;

describe("decideSettlement", () => {
  it("waits while a sent transaction has not been seen, then fails it once its blockhash must have expired", () => {
    assert.equal(decideSettlement({ found: false }, T0, T0 + 30_000).step, "wait");
    const late = decideSettlement({ found: false }, T0, T0 + SETTLE_TIMEOUT_MS + 1);
    assert.equal(late.step, "failed");
  });

  it("never fails a trade because the status lookup itself failed", () => {
    assert.equal(decideSettlement(null, T0, T0 + 10 * SETTLE_TIMEOUT_MS).step, "wait");
  });

  it("an on-chain error fails the trade immediately", () => {
    const r = decideSettlement({ found: true, err: { InstructionError: [1, "Custom"] }, confirmationStatus: "confirmed" }, T0, T0);
    assert.equal(r.step, "failed");
  });

  it("books only at confirmed or finalized, not processed", () => {
    assert.equal(decideSettlement({ found: true, err: null, confirmationStatus: "processed" }, T0, T0).step, "wait");
    assert.equal(decideSettlement({ found: true, err: null, confirmationStatus: "confirmed" }, T0, T0).step, "read_transaction");
    assert.equal(decideSettlement({ found: true, err: null, confirmationStatus: "finalized" }, T0, T0).step, "read_transaction");
  });
});

const buyFill: SwapFill = {
  side: "buy",
  wallet: "W",
  tokensRaw: 1_846_463_290_623n,
  decimals: 6,
  allInLamports: 61_538_840,
  feeLamports: 25_000,
  tokenAccountRentLamports: 1_513_840,
  priceSol: 3.249455340092675e-8,
};

describe("bookBuy / bookSell", () => {
  it("a buy books its all-in cost and an entry price on the vSol scale", () => {
    const b = bookBuy(buyFill)!;
    assert.equal(b.costSol, 0.06153884);
    assert.ok(Math.abs(b.entryVSol - Math.sqrt(3.249455340092675e-8 * 32.19 * 1e9)) < 1e-9);
    assert.equal(bookBuy({ ...buyFill, side: "sell" }), null);
  });

  it("a partial sell realizes proceeds minus the exact share of cost it disposed of", () => {
    const sell: SwapFill = { ...buyFill, side: "sell", tokensRaw: buyFill.tokensRaw / 2n, allInLamports: 40_000_000, priceSol: 4.3e-8 };
    const s = bookSell({ fill: sell, costSol: 0.06153884, boughtTokensRaw: buyFill.tokensRaw, requestedPct: 30 })!;
    assert.ok(Math.abs(s.fractionSold - 0.5) < 1e-9, "token ratio wins over the requested percent");
    assert.ok(Math.abs(s.realizedSol - (0.04 - 0.06153884 / 2)) < 1e-12);
  });

  it("falls back to the requested percent when the buy's token count is unknown", () => {
    const sell: SwapFill = { ...buyFill, side: "sell", allInLamports: 10_000_000 };
    const s = bookSell({ fill: sell, costSol: 0.1, boughtTokensRaw: null, requestedPct: 50 })!;
    assert.equal(s.fractionSold, 0.5);
  });

  it("final P&L is everything received minus the cost, across all legs", () => {
    assert.ok(Math.abs(finalPnlSol({ costSol: 0.06153884, proceedsSolTotal: 0.04 + 0.035 }) - 0.01346116) < 1e-12);
  });
});
