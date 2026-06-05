import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { clamp01, launchQualityScore, launchRankScore } from "@/lib/intelligence/launch-rank";

/**
 * A6 maturity de-bias. The launch rank/floor used to be ≈ pure graduation progress,
 * so fresh launches were ranked below mature coins regardless of velocity. These
 * helpers add a maturity-INDEPENDENT quality signal; the tests lock in that a fast
 * fresh launch can now out-rank a slow mature coin (the core of the fix).
 */
describe("launchQualityScore (A6)", () => {
  it("scores a fast, organically-bought launch high", () => {
    const q = launchQualityScore({
      velocity: 1, // +100% liquidity
      uniqueBuyers5m: 12,
      earlyUniqueBuyers: 4,
      buys5m: 40,
      sells5m: 5,
    });
    assert.ok(q > 0.7, `expected high, got ${q}`);
  });

  it("scores a flat, low-activity launch low", () => {
    const q = launchQualityScore({
      velocity: 0,
      uniqueBuyers5m: 1,
      earlyUniqueBuyers: 5,
      buys5m: 1,
      sells5m: 6,
    });
    assert.ok(q < 0.2, `expected low, got ${q}`);
  });

  it("does NOT reward maturity — only velocity/flow drive it", () => {
    // Two coins, identical flow; maturity (graduation) is not an input at all.
    const a = launchQualityScore({ velocity: 0.6, uniqueBuyers5m: 8, buys5m: 20, sells5m: 8 });
    const b = launchQualityScore({ velocity: 0.6, uniqueBuyers5m: 8, buys5m: 20, sells5m: 8 });
    assert.equal(a, b);
  });

  it("is robust to missing / invalid inputs (neutral, never NaN)", () => {
    const q = launchQualityScore({
      velocity: null,
      uniqueBuyers5m: null,
      buys5m: null,
      sells5m: null,
    });
    assert.ok(Number.isFinite(q) && q >= 0 && q <= 1, `got ${q}`);
    assert.equal(clamp01(Number.NaN), 0);
    assert.equal(clamp01(2), 1);
    assert.equal(clamp01(-1), 0);
  });

  it("uses absolute buyer scale when no early cohort is given", () => {
    const few = launchQualityScore({ velocity: 0, uniqueBuyers5m: 2, buys5m: 5, sells5m: 5 });
    const many = launchQualityScore({ velocity: 0, uniqueBuyers5m: 8, buys5m: 5, sells5m: 5 });
    assert.ok(many > few);
  });
});

describe("launchRankScore (A6 — profit-adaptive de-bias)", () => {
  it("while launches are PROFITABLE (higher weight), a fast fresh launch out-ranks a slow mature coin", () => {
    const w = 0.45; // relaxed/launch tier proving profitable → lean in
    const fresh = launchRankScore(0.3, 0.9, w);
    const mature = launchRankScore(0.85, 0.1, w);
    assert.ok(fresh > mature, `fresh ${fresh} should beat mature ${mature}`);
  });

  it("when launches are UNPROFITABLE (low weight), proven confluence leads — no launch chasing", () => {
    const w = 0.12; // learner disabled the relaxed tier → focus on profitable signals
    const fresh = launchRankScore(0.3, 0.9, w);
    const mature = launchRankScore(0.85, 0.1, w);
    assert.ok(mature > fresh, `mature ${mature} should lead when launches don't pay`);
  });

  it("does NOT reward a fresh launch that is also slow (no free pass for being new)", () => {
    const freshSlow = launchRankScore(0.3, 0.15, 0.45);
    const mature = launchRankScore(0.85, 0.1, 0.45);
    assert.ok(freshSlow < mature, `slow fresh ${freshSlow} should stay below mature ${mature}`);
  });

  it("clamps weight to [0,0.5], inputs to [0,1], and defaults to a conservative 0.35", () => {
    assert.equal(launchRankScore(0, 0, 0.4), 0);
    assert.ok(launchRankScore(2, 2, 0.4) <= 1);
    // weight clamped 0.9 → 0.5
    assert.ok(Math.abs(launchRankScore(0.4, 0.8, 0.9) - (0.4 * 0.5 + 0.8 * 0.5)) < 1e-9);
    // default weight 0.35 (confluence leads)
    assert.ok(Math.abs(launchRankScore(0.4, 0.8) - (0.4 * 0.65 + 0.8 * 0.35)) < 1e-9);
  });
});
