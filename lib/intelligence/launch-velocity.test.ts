import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { scoreLaunchVelocity, DEFAULT_VELOCITY_CONFIG } from "@/lib/intelligence/launch-velocity";

describe("launch-velocity", () => {
  it("scores an accelerating launch high", () => {
    const r = scoreLaunchVelocity({
      vSol: 30,
      priorVSol: 18, // +66% growth
      uniqueBuyers: 10,
      buySellRatio: 0.8,
      priceImpulsePct: 40,
    });
    assert.ok(r.score >= 0.6, `expected >=0.6, got ${r.score}`);
    assert.equal(r.vetoed, false);
  });

  it("scores a flat, low-activity launch low", () => {
    const r = scoreLaunchVelocity({
      vSol: 12,
      priorVSol: 12, // no growth
      uniqueBuyers: 1,
      buySellRatio: 0.5,
      priceImpulsePct: 1,
    });
    assert.ok(r.score < 0.4, `expected <0.4, got ${r.score}`);
  });

  it("hard-vetoes a thinning launch (liquidity bleeding)", () => {
    const r = scoreLaunchVelocity({
      vSol: 8,
      priorVSol: 20, // dropped well below 0.85×
      uniqueBuyers: 12,
      buySellRatio: 0.9,
      priceImpulsePct: 50,
    });
    assert.equal(r.score, 0);
    assert.equal(r.vetoReason, "liquidity_thinning");
  });

  it("hard-vetoes a bundle launch regardless of activity", () => {
    const r = scoreLaunchVelocity({
      vSol: 30,
      priorVSol: 10,
      uniqueBuyers: 20,
      buySellRatio: 0.95,
      bundleLaunch: true,
    });
    assert.equal(r.score, 0);
    assert.equal(r.vetoReason, "bundle_launch");
  });

  it("USD-scaled config still ranks growth + buyers correctly", () => {
    const usdCfg = { ...DEFAULT_VELOCITY_CONFIG, minVSol: 3_000 };
    const strong = scoreLaunchVelocity(
      { vSol: 5_000, priorVSol: 3_000, uniqueBuyers: 9, buySellRatio: 0.75, priceImpulsePct: 30 },
      usdCfg,
    );
    const weak = scoreLaunchVelocity(
      { vSol: 3_100, priorVSol: 3_000, uniqueBuyers: 2, buySellRatio: 0.52, priceImpulsePct: 2 },
      usdCfg,
    );
    assert.ok(strong.score > weak.score);
    assert.ok(strong.score >= 0.4);
  });
});
