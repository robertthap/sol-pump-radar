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

// T0.3 — cap raised from 800 → 5000 bps. Cap is a backstop only; the real
// slippage IS the deterministic curve-impact below the cap.
test("slippage: caps impact at the new 5000 bps backstop (not the old 800)", () => {
  const huge = applySlippage({ side: "BUY", quotePrice: 100, notionalSol: 1000, referenceVSol: 1 });
  assert.ok(huge.slippageBps <= 5030, `expected <=5030 bps cap, got ${huge.slippageBps}`);
  // And critically — proves the old 800 cap is gone, so honest paper PnL is no longer
  // dishonestly flattering on thin-pool buys.
  assert.ok(huge.slippageBps > 800, `expected >800 bps now that the dishonest cap is removed, got ${huge.slippageBps}`);
});

test("slippage: never returns non-positive price", () => {
  const r = applySlippage({ side: "SELL", quotePrice: 100, notionalSol: 0.5, referenceVSol: 0.5 });
  assert.ok(r.fillPrice > 0);
});

// T0.3 plan acceptance: "a 5% pool-consumption buy on a thin pool produces > 8%
// slippage END-TO-END". The applySlippage return is in vSol terms (~500 bps for
// 5% consumption). The downstream PnL math squares it because curve value ∝ vSol²,
// so the realized end-to-end impact is ((1+s))² - 1, not s.
test("slippage end-to-end: 5% pool consumption → >8% PnL impact via quadratic curve", () => {
  const preVSol = 20;
  const notional = 1; // 5% pool consumption
  const slip = applySlippage({ side: "BUY", quotePrice: preVSol, notionalSol: notional, referenceVSol: preVSol });
  // vSol-fraction slippage: should be ~500 bps + 30 base = 530 bps, well under the cap
  const fracVSol = slip.fillPrice / preVSol;
  // End-to-end PnL impact = (fillPrice/quote)^2 - 1 (curve value ∝ vSol²)
  const endToEndPct = fracVSol * fracVSol - 1;
  assert.ok(
    endToEndPct > 0.08,
    `expected >8% end-to-end PnL impact from 5% pool consumption, got ${(endToEndPct * 100).toFixed(2)}%`,
  );
});

// T0.3 honesty check: under the old 800-bps cap, a 50% pool consumption was
// charged ~17% in PnL terms (cap clipped it). Under the new 5000-bps backstop,
// the real impact (~125% in value) is allowed through. This is the test that
// proves the cap raise actually changes the answer for honest measurement.
test("slippage end-to-end: 50% pool consumption now charges the real curve impact", () => {
  const preVSol = 10;
  const notional = 5; // 50% pool consumption — extreme but representative of thin-pool genesis trades
  const slip = applySlippage({ side: "BUY", quotePrice: preVSol, notionalSol: notional, referenceVSol: preVSol });
  // Pre-fix: capped at 800 bps → fillPrice = 10·1.08 = 10.8 → end-to-end = 16.6%
  // Post-fix: 5000-bps consumed = 50% → fillPrice = 10·1.50 = 15.0 → end-to-end = 125%
  const fracVSol = slip.fillPrice / preVSol;
  const endToEndPct = fracVSol * fracVSol - 1;
  assert.ok(
    endToEndPct > 0.5,
    `expected >50% end-to-end impact on 50% pool consumption (was ~17% under old cap), got ${(endToEndPct * 100).toFixed(1)}%`,
  );
});
