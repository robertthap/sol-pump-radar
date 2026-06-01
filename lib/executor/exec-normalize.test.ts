import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildExecutionPlan,
  toExecutionOutcome,
  computeSlippageBps,
  execMemoryFields,
  type TradeIntent,
} from "@/lib/executor/exec-normalize";

function intent(overrides: Partial<TradeIntent> = {}): TradeIntent {
  return {
    intentId: "t1",
    mint: "MintX",
    side: "buy",
    mode: "paper",
    sizeSol: 0.05,
    reason: "BUY_STRONG",
    tier: "strict",
    regime: "neutral",
    createdAtMs: 1_000,
    ...overrides,
  };
}

describe("computeSlippageBps", () => {
  it("computes positive/negative slippage in bps", () => {
    assert.equal(computeSlippageBps(100, 101), 100); // +1%
    assert.equal(computeSlippageBps(100, 99), -100); // -1%
  });
  it("returns 0 on invalid inputs", () => {
    assert.equal(computeSlippageBps(0, 100), 0);
    assert.equal(computeSlippageBps(100, 0), 0);
  });
});

describe("toExecutionOutcome", () => {
  const plan = buildExecutionPlan(intent(), {
    route: "paper",
    expectedPriceSol: 100,
    maxSlippageBps: 500,
    priorityFeeSol: 0,
    poolLiquiditySol: 100,
    plannedAtMs: 1_000,
  });

  it("normalizes a filled outcome and derives latency", () => {
    const o = toExecutionOutcome(plan, {
      status: "filled",
      fillPriceSol: 102,
      filledSol: 0.05,
      filledAtMs: 1_250,
    });
    assert.equal(o.status, "filled");
    assert.equal(o.slippageBpsRealized, 200); // derived from 100→102
    assert.equal(o.latencyMs, 250); // 1250 - 1000
    assert.equal(o.retries, 0);
  });

  it("prefers an executor-supplied realized slippage", () => {
    const o = toExecutionOutcome(plan, {
      status: "filled",
      fillPriceSol: 102,
      filledSol: 0.05,
      slippageBpsRealized: 73,
      filledAtMs: 1_100,
    });
    assert.equal(o.slippageBpsRealized, 73);
  });

  it("carries reject reason and never negative latency", () => {
    const o = toExecutionOutcome(plan, {
      status: "rejected",
      fillPriceSol: null,
      filledSol: 0,
      rejectReason: "INSUFFICIENT_BALANCE",
      filledAtMs: 500, // before createdAt → clamped to 0
    });
    assert.equal(o.status, "rejected");
    assert.equal(o.rejectReason, "INSUFFICIENT_BALANCE");
    assert.equal(o.latencyMs, 0);
    assert.equal(o.fillPriceSol, null);
  });

  it("execMemoryFields exposes the L2 execution-memory record", () => {
    const o = toExecutionOutcome(plan, { status: "filled", fillPriceSol: 102, filledSol: 0.05, filledAtMs: 1_100 });
    const f = execMemoryFields(o);
    assert.equal(f.exec_status, "filled");
    assert.equal(f.exec_route, "paper");
    assert.equal(f.exec_slippage_bps, 200);
    assert.equal(f.exec_expected_price, 100);
  });
});
