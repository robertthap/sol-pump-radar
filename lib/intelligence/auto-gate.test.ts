import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeAutoTradeAllowedCore,
  isActionableSignalCore,
} from "@/lib/intelligence/auto-gate-core";
import { defaultGateConfig, resolveGateConfig } from "@/lib/intelligence/gate-config";

describe("auto-gate", () => {
  it("blocks engine B when state is not acceleration", () => {
    const allowed = computeAutoTradeAllowedCore(
      {
        engine: "B",
        state: "parabolic",
        rank_percentile: 0.9,
        signal: "CONTINUATION_BUY",
        confidence: 0.7,
        trigger_events: [{ kind: "volume_spike" }],
      },
      { liquidity_usd: 25_000, price_change_h1: 10 },
    );
    assert.equal(allowed, false);
  });

  it("allows engine B continuation buy in acceleration with rank", () => {
    const allowed = computeAutoTradeAllowedCore(
      {
        engine: "B",
        state: "acceleration",
        rank_percentile: 0.9,
        signal: "CONTINUATION_BUY",
        confidence: 0.7,
        trigger_events: [{ kind: "volume_spike" }],
      },
      { liquidity_usd: 25_000, price_change_h1: 10 },
    );
    assert.equal(allowed, true);
  });

  it("isActionable includes WATCH", () => {
    assert.equal(isActionableSignalCore("WATCH"), true);
    assert.equal(isActionableSignalCore("NONE"), false);
  });

  it("launch mode allows a fresh low-liquidity engine-A breakout", () => {
    const allowed = computeAutoTradeAllowedCore(
      {
        engine: "A",
        state: "launching",
        rank_percentile: 0.6,
        signal: "BUY_STRONG",
        confidence: 0.6,
        trigger_events: [{ kind: "new_pool_detected" }],
      },
      { liquidity_usd: 2_500, price_change_h1: 30 },
      {},
      defaultGateConfig("launch"),
    );
    assert.equal(allowed, true);
  });

  it("profit mode rejects the same fresh low-liquidity mint (mcap bias guard)", () => {
    const allowed = computeAutoTradeAllowedCore(
      {
        engine: "A",
        state: "launching",
        rank_percentile: 0.6,
        signal: "BUY_STRONG",
        confidence: 0.6,
        trigger_events: [],
      },
      { liquidity_usd: 2_500, price_change_h1: 30 },
      {},
      defaultGateConfig("profit"),
    );
    assert.equal(allowed, false);
  });

  it("learner override moves a borderline rank from reject to allow (clamped)", () => {
    const output = {
      engine: "A" as const,
      state: "early_breakout",
      rank_percentile: 0.47,
      signal: "BUY_STRONG" as const,
      confidence: 0.6,
      trigger_events: [{ kind: "volume_spike" }],
    };
    const input = { liquidity_usd: 2_500, price_change_h1: 20 };
    // Default launch rank floor is 0.50 → 0.47 rejected.
    assert.equal(
      computeAutoTradeAllowedCore(output, input, {}, defaultGateConfig("launch")),
      false,
    );
    // Learner lowers the rank floor toward 0.45 (within clamp) → now allowed.
    const tuned = resolveGateConfig("launch", { engineARankFloor: 0.45 });
    assert.equal(computeAutoTradeAllowedCore(output, input, {}, tuned), true);
  });

  it("risk flags still hard-veto regardless of mode", () => {
    const allowed = computeAutoTradeAllowedCore(
      {
        engine: "A",
        state: "acceleration",
        rank_percentile: 0.9,
        signal: "BUY_STRONG",
        confidence: 0.9,
        trigger_events: [{ kind: "volume_spike" }],
      },
      { liquidity_usd: 50_000, price_change_h1: 20 },
      { rug: true },
      defaultGateConfig("launch"),
    );
    assert.equal(allowed, false);
  });
});
