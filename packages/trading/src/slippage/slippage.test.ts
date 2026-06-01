import { test } from "node:test";
import assert from "node:assert/strict";
import { applySlippage } from "./index";

test("slippage: buy raises price, sell lowers", () => {
  const buy = applySlippage({ side: "BUY", quotePrice: 100, notionalSol: 0.1, referenceVSol: 50 });
  const sell = applySlippage({ side: "SELL", quotePrice: 100, notionalSol: 0.1, referenceVSol: 50 });
  assert.ok(buy.fillPrice > 100);
  assert.ok(sell.fillPrice < 100);
  assert.equal(buy.slippageBps, sell.slippageBps);
});

test("slippage: thinner liquidity = larger impact", () => {
  const fat = applySlippage({ side: "BUY", quotePrice: 100, notionalSol: 0.1, referenceVSol: 100 });
  const thin = applySlippage({ side: "BUY", quotePrice: 100, notionalSol: 0.1, referenceVSol: 1 });
  assert.ok(thin.slippageBps > fat.slippageBps);
});

test("slippage: caps impact", () => {
  const huge = applySlippage({ side: "BUY", quotePrice: 100, notionalSol: 1000, referenceVSol: 1 });
  assert.ok(huge.slippageBps <= 830, `expected <=830 bps cap, got ${huge.slippageBps}`);
});

test("slippage: never returns non-positive price", () => {
  const r = applySlippage({ side: "SELL", quotePrice: 100, notionalSol: 0.5, referenceVSol: 0.5 });
  assert.ok(r.fillPrice > 0);
});
