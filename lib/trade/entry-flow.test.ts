import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  BASELINE_FLOW,
  flowThresholdsFor,
  passesFlowGate,
  relaxMomentumThresholds,
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

describe("relaxMomentumThresholds — the smart-money boost", () => {
  const MOM = flowThresholdsFor({ minDexBuysM5: 8, minDexBuySellRatio: 1.0, minDexVolAccel: 0.5 });

  it("halves the opt-in magnitudes", () => {
    const r = relaxMomentumThresholds(MOM, 0.5);
    assert.equal(r.minBuys, 4);
    assert.equal(r.minVolAccel, 0.25);
  });

  // The whole safety argument for the boost rests on this.
  it("never touches the baseline dead/dumping rules", () => {
    const r = relaxMomentumThresholds(MOM, 0.5);
    assert.equal(r.minTrades, BASELINE_FLOW.minTrades);
    assert.equal(r.dumpRatio, BASELINE_FLOW.dumpRatio);
    assert.equal(r.dumpMinTrades, BASELINE_FLOW.dumpMinTrades);
  });

  it("a dead coin is still rejected under the boost", () => {
    const r = passesFlowGate(snap({ buysM5: 1, sellsM5: 1 }), relaxMomentumThresholds(MOM, 0.5));
    assert.equal(r.allow, false);
    assert.match((r as { reason: string }).reason, /dead/);
  });

  it("a dumping coin is still rejected under the boost", () => {
    const dumping = snap({ buysM5: 3, sellsM5: 15, buySellRatio: 0.2, priceChangeM5: -20, volAcceleration: 9 });
    const r = passesFlowGate(dumping, relaxMomentumThresholds(MOM, 0.5));
    assert.equal(r.allow, false);
    assert.match((r as { reason: string }).reason, /dumping/);
  });

  // A ratio is not a magnitude: halving it would change the rule from
  // "buyers outnumber sellers" to "sellers may win 2:1".
  it("leaves minRatio alone", () => {
    assert.equal(relaxMomentumThresholds(MOM, 0.5).minRatio, MOM.minRatio);
  });

  it("relaxing a preset with no momentum layer is a no-op", () => {
    assert.deepEqual(relaxMomentumThresholds(flowThresholdsFor({}), 0.5), flowThresholdsFor({}));
  });

  it("never relaxes minBuys below 1 — 'some buyers' is the floor", () => {
    const tiny = flowThresholdsFor({ minDexBuysM5: 1 });
    assert.equal(relaxMomentumThresholds(tiny, 0.1).minBuys, 1);
  });

  it("clamps the factor to [0,1] so a bad caller cannot TIGHTEN the gate", () => {
    assert.equal(relaxMomentumThresholds(MOM, 2).minBuys, MOM.minBuys);
    assert.equal(relaxMomentumThresholds(MOM, -1).minVolAccel, 0);
  });

  it("a boosted coin that clears the halved bar passes where it previously failed", () => {
    const s = snap({ buysM5: 5, sellsM5: 2, buySellRatio: 2.5, volAcceleration: 0.3, priceChangeM5: 1 });
    assert.equal(passesFlowGate(s, MOM).allow, false, "5 buys < 8 without the boost");
    assert.equal(passesFlowGate(s, relaxMomentumThresholds(MOM, 0.5)).allow, true);
  });
});
