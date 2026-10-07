import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CURVE_FEE, AMM_FEE, BASE_TX_FEE_SOL, ATA_RENT_SOL,
  tradingFeeBps, tradingFeeSol, txCostSol, failedTxCostSol, ataRentSol, roundTripCostSol,
  type FeeModel,
} from "@spr/trading";

/**
 * M03 — one fee model for both paper engines.
 *
 * The general executor charged 1.00% and the research engine 1.25%, both into
 * the same ledger. These tests pin the shared model so the two cannot drift
 * apart again, and so a change to any constant is a visible, deliberate edit.
 */
const model = (over: Partial<FeeModel> = {}): FeeModel => ({
  venue: "curve", priorityFeeSol: 0.0005, enabled: true, ...over,
});

describe("fee model (M03)", () => {
  it("the curve fee is 1.25%, split 0.95 protocol + 0.30 creator", () => {
    assert.equal(CURVE_FEE.totalBps, 125);
    assert.equal(CURVE_FEE.protocolBps! + CURVE_FEE.creatorBps!, CURVE_FEE.totalBps);
  });

  it("the AMM total is 1.25% and its split is recorded as unmeasured, not invented", () => {
    assert.equal(AMM_FEE.totalBps, 125);
    assert.equal(AMM_FEE.protocolBps, null);
    assert.equal(AMM_FEE.creatorBps, null);
  });

  it("both venues charge the same bps, so neither engine is cheaper by accident", () => {
    assert.equal(tradingFeeBps(model({ venue: "curve" })), tradingFeeBps(model({ venue: "amm" })));
  });

  it("a failed transaction costs base plus priority and trades nothing", () => {
    const m = model();
    assert.ok(Math.abs(failedTxCostSol(m) - (BASE_TX_FEE_SOL + 0.0005)) < 1e-12);
    assert.equal(failedTxCostSol(m), txCostSol(m));
    assert.ok(failedTxCostSol(m) > 0, "a failed tx is never free");
  });

  it("the base signature fee is charged, not just the priority fee", () => {
    const noPriority = model({ priorityFeeSol: 0 });
    assert.equal(txCostSol(noPriority), BASE_TX_FEE_SOL);
    assert.ok(txCostSol(noPriority) > 0, "base fee was previously ignored entirely");
  });

  it("rent is owed while the account is open and returns when it closes", () => {
    assert.equal(ataRentSol(model(), false), ATA_RENT_SOL);
    assert.equal(ataRentSol(model(), true), 0);
  });

  it("disabling fees zeroes every component", () => {
    const off = model({ enabled: false });
    assert.equal(tradingFeeSol(1, off), 0);
    assert.equal(txCostSol(off), 0);
    assert.equal(failedTxCostSol(off), 0);
    assert.equal(ataRentSol(off, false), 0);
    assert.equal(roundTripCostSol(1, off).totalSol, 0);
  });

  it("the exit fee is charged on what is left, not on the entry notional", () => {
    const rt = roundTripCostSol(1, model({ priorityFeeSol: 0 }));
    assert.ok(Math.abs(rt.entryTradingFeeSol - 0.0125) < 1e-12);
    // 1.25% of the 0.9875 that actually compounds — NOT another 0.0125.
    assert.ok(Math.abs(rt.exitTradingFeeSol - 0.9875 * 0.0125) < 1e-12);
    assert.ok(rt.exitTradingFeeSol < rt.entryTradingFeeSol);
  });

  it("states the break-even a strategy must clear", () => {
    const rt = roundTripCostSol(0.349, model({ priorityFeeSol: 0.0005 }));
    // 2.48% trading + two legs of network cost on a small position.
    assert.ok(rt.totalFraction > 0.024 && rt.totalFraction < 0.032, `got ${rt.totalFraction}`);
    assert.ok(
      Math.abs(rt.totalSol - (rt.entryTradingFeeSol + rt.exitTradingFeeSol + rt.txCostSol)) < 1e-12,
    );
  });

  it("the flat network cost hurts small positions far more", () => {
    const m = model({ priorityFeeSol: 0.0005 });
    const big = roundTripCostSol(1, m).totalFraction;
    const small = roundTripCostSol(0.01, m).totalFraction;
    assert.ok(small > big * 1.5, `small ${small} vs big ${big} — flat cost must dominate`);
  });

  it("an override is honoured but cannot go negative", () => {
    assert.equal(tradingFeeBps(model({ tradingFeeBpsOverride: 100 })), 100);
    assert.equal(tradingFeeBps(model({ tradingFeeBpsOverride: -5 })), 125);
    assert.equal(tradingFeeBps(model({ tradingFeeBpsOverride: null })), 125);
  });
});
