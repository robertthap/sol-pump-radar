import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  BASELINE_FLOW,
  flowThresholdsFor,
  passesFlowGate,
  type FlowSnapshot,
} from "@/lib/trade/entry-flow";

const snap = (o: Partial<FlowSnapshot>): FlowSnapshot => ({
  buysM5: 0, sellsM5: 0, buySellRatio: 0, volAcceleration: 0, priceChangeM5: 0, ...o,
});

describe("baseline flow gate", () => {
  it("a fresh curve launch (no DEX data) is never blocked — genesis depends on this", () => {
    assert.deepEqual(passesFlowGate(null, BASELINE_FLOW), { allow: true });
    assert.deepEqual(passesFlowGate(undefined, BASELINE_FLOW), { allow: true });
  });

  // The two real entries that prompted this work.
  it("rejects the 0-buy / 0-sell coin", () => {
    const r = passesFlowGate(snap({}), BASELINE_FLOW);
    assert.equal(r.allow, false);
    assert.match((r as { reason: string }).reason, /dead: 0 trades/);
  });

  it("rejects the 0-buy / 1-sell / $1-volume coin", () => {
    const r = passesFlowGate(snap({ sellsM5: 1 }), BASELINE_FLOW);
    assert.equal(r.allow, false);
  });

  it("rejects a coin being dumped: 5 buys / 17 sells with price falling", () => {
    const r = passesFlowGate(
      snap({ buysM5: 5, sellsM5: 17, buySellRatio: 5 / 17, priceChangeM5: -3.8 }),
      BASELINE_FLOW,
    );
    assert.equal(r.allow, false);
    assert.match((r as { reason: string }).reason, /dumping/);
  });

  it("does NOT reject net selling when price is rising — that is rotation, not a dump", () => {
    assert.deepEqual(
      passesFlowGate(snap({ buysM5: 5, sellsM5: 10, buySellRatio: 0.5, priceChangeM5: 16.5 }), BASELINE_FLOW),
      { allow: true },
    );
  });

  it("lets an ordinary live coin through", () => {
    assert.deepEqual(
      passesFlowGate(snap({ buysM5: 11, sellsM5: 8, buySellRatio: 1.38, priceChangeM5: -11.5 }), BASELINE_FLOW),
      { allow: true },
    );
  });

  it("thin-but-not-dead coins clear the trade floor at exactly the boundary", () => {
    assert.equal(passesFlowGate(snap({ buysM5: 4, sellsM5: 1, buySellRatio: 4 }), BASELINE_FLOW).allow, true);
    assert.equal(passesFlowGate(snap({ buysM5: 3, sellsM5: 1, buySellRatio: 3 }), BASELINE_FLOW).allow, false);
  });
});

describe("momentum thresholds (opt-in)", () => {
  const MOMENTUM = flowThresholdsFor({ minDexBuysM5: 8, minDexBuySellRatio: 1.0, minDexVolAccel: 0.5 });

  it("passes a coin whose activity is accelerating with buyers on top", () => {
    assert.deepEqual(
      passesFlowGate(snap({ buysM5: 48, sellsM5: 31, buySellRatio: 1.55, volAcceleration: 1.07 }), MOMENTUM),
      { allow: true },
    );
  });

  it("rejects a busy coin whose activity is NOT accelerating", () => {
    // 79 buys but accel 0.00 — trading at its own average pace, going nowhere.
    const r = passesFlowGate(snap({ buysM5: 79, sellsM5: 79, buySellRatio: 1.0, volAcceleration: 0 }), MOMENTUM);
    assert.equal(r.allow, false);
    assert.match((r as { reason: string }).reason, /vol accel/);
  });

  it("rejects acceleration with sellers on top", () => {
    const r = passesFlowGate(snap({ buysM5: 55, sellsM5: 65, buySellRatio: 0.85, volAcceleration: 1.36 }), MOMENTUM);
    assert.equal(r.allow, false);
    assert.match((r as { reason: string }).reason, /b\/s/);
  });

  it("rejects acceleration on too few participants", () => {
    const r = passesFlowGate(snap({ buysM5: 5, sellsM5: 1, buySellRatio: 5, volAcceleration: 0.93 }), MOMENTUM);
    assert.equal(r.allow, false);
    assert.match((r as { reason: string }).reason, /buys\/5m/);
  });

  it("baseline still applies underneath — a dead coin fails before momentum is considered", () => {
    const r = passesFlowGate(snap({}), MOMENTUM);
    assert.match((r as { reason: string }).reason, /dead/);
  });

  it("undefined thresholds disable the momentum layer entirely", () => {
    const none = flowThresholdsFor({});
    assert.deepEqual(
      passesFlowGate(snap({ buysM5: 6, sellsM5: 2, buySellRatio: 3, volAcceleration: 0 }), none),
      { allow: true },
    );
  });
});
