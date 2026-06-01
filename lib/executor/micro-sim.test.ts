import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { microSimulate } from "@/lib/executor/micro-sim";

describe("microSimulate", () => {
  it("passes a small order into deep liquidity", () => {
    const r = microSimulate({ sizeSol: 0.05, poolLiquiditySol: 100, maxSlippageBps: 500 });
    assert.equal(r.ok, true);
    assert.ok(r.expectedSlippageBps < 500);
  });

  it("rejects a large order into thin liquidity (slippage blowout)", () => {
    const r = microSimulate({ sizeSol: 5, poolLiquiditySol: 10, maxSlippageBps: 500 });
    assert.equal(r.ok, false);
    assert.match(r.reason ?? "", /slippage/);
  });

  it("rejects when liquidity is thinning", () => {
    const r = microSimulate({ sizeSol: 0.05, poolLiquiditySol: 100, maxSlippageBps: 500, liquidityTrend: -0.3 });
    assert.equal(r.ok, false);
    assert.match(r.reason ?? "", /thinning/);
  });

  it("rejects on a priority-fee gas spike", () => {
    const r = microSimulate({
      sizeSol: 0.05,
      poolLiquiditySol: 100,
      maxSlippageBps: 500,
      priorityFeeSol: 0.01,
      baselinePriorityFeeSol: 0.001,
    });
    assert.equal(r.ok, false);
    assert.match(r.reason ?? "", /priority-fee/);
  });

  it("recent volatility widens expected slippage", () => {
    const calm = microSimulate({ sizeSol: 0.05, poolLiquiditySol: 100, maxSlippageBps: 5000, recentVolatilityPct: 0 });
    const wild = microSimulate({ sizeSol: 0.05, poolLiquiditySol: 100, maxSlippageBps: 5000, recentVolatilityPct: 50 });
    assert.ok(wild.expectedSlippageBps > calm.expectedSlippageBps);
  });
});
