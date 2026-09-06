import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_FRICTION,
  planProfitTarget,
  requiredGrossRatio,
  requiredVSolMovePct,
} from "@/lib/trade/profit-target";

/** Replays the executor's own arithmetic, so these tests fail if it drifts. */
function executorPnl(notionalSol: number, grossRatio: number): number {
  const grossOut = notionalSol * grossRatio;
  const exitFee = (grossOut * DEFAULT_FRICTION.feeBps) / 10_000;
  const priorityRoundTrip = DEFAULT_FRICTION.priorityFeeSol * 2;
  return grossOut - exitFee - priorityRoundTrip - notionalSol;
}

describe("requiredGrossRatio", () => {
  // The number the whole feature turns on: what does break-even actually cost?
  it("break-even needs about +2% of value, not 0", () => {
    const r = requiredGrossRatio({ notionalSol: 0.1, targetSol: 0 })!;
    assert.ok(r > 1.019 && r < 1.021, `expected ~1.0202, got ${r}`);
  });

  it("the ratio it returns produces EXACTLY the requested profit in the executor's own maths", () => {
    for (const notional of [0.01, 0.03, 0.1, 1]) {
      for (const target of [0, 0.001, 0.0133, 0.1]) {
        const r = requiredGrossRatio({ notionalSol: notional, targetSol: target })!;
        const pnl = executorPnl(notional, r);
        assert.ok(Math.abs(pnl - target) < 1e-9, `notional ${notional} target ${target}: got ${pnl}`);
      }
    }
  });

  // The flat priority fee is why "trade smaller to risk less" backfires.
  it("a smaller stake needs a BIGGER move for the same cash target", () => {
    const big = requiredGrossRatio({ notionalSol: 0.1, targetSol: 0.0133 })!;
    const small = requiredGrossRatio({ notionalSol: 0.01, targetSol: 0.0133 })!;
    assert.ok(small > big, "halving the stake does not halve the required move");
  });

  it("returns null for a nonsense stake", () => {
    assert.equal(requiredGrossRatio({ notionalSol: 0, targetSol: 1 }), null);
    assert.equal(requiredGrossRatio({ notionalSol: -1, targetSol: 1 }), null);
  });
});

describe("requiredVSolMovePct", () => {
  // Value goes as vSol squared; quoting the wrong one misstates the target 2x.
  it("is the square root of the value ratio, not the value ratio", () => {
    const v = requiredVSolMovePct({ notionalSol: 0.1, targetSol: 0.0133 })!;
    const r = requiredGrossRatio({ notionalSol: 0.1, targetSol: 0.0133 })!;
    assert.ok(Math.abs(1 + v - Math.sqrt(r)) < 1e-12);
    assert.ok(v < r - 1, "the vSol move is smaller than the value move");
  });
});

describe("planProfitTarget", () => {
  // The operator's actual request, at the SOL price the system reports.
  it("$2 on 0.1 SOL at SOL=$150 needs about +13.3% net and about +7.5% vSol", () => {
    const p = planProfitTarget({ notionalSol: 0.1, targetUsd: 2, solUsd: 150 })!;
    assert.ok(Math.abs(p.netPct - 0.1333) < 0.002, `netPct ${p.netPct}`);
    assert.ok(Math.abs(p.vSolMovePct - 0.075) < 0.003, `vSolMovePct ${p.vSolMovePct}`);
    assert.equal(p.implausible, false);
    assert.match(p.reason, /13\.3% net/);
  });

  it("the same $2 on a 0.01 SOL stake is flagged implausible, not silently accepted", () => {
    const p = planProfitTarget({ notionalSol: 0.01, targetUsd: 2, solUsd: 150 })!;
    assert.equal(p.implausible, true, "$2 on $1.50 of stake is a 2x, not a scalp");
    assert.match(p.reason, /raise the stake or lower the target/);
  });

  it("tracks the SOL price - the same cash target is a smaller move when SOL is dearer", () => {
    const cheap = planProfitTarget({ notionalSol: 0.1, targetUsd: 2, solUsd: 100 })!;
    const dear = planProfitTarget({ notionalSol: 0.1, targetUsd: 2, solUsd: 300 })!;
    assert.ok(dear.netPct < cheap.netPct);
  });

  it("a zero target still has to clear friction", () => {
    const p = planProfitTarget({ notionalSol: 0.1, targetUsd: 0, solUsd: 150 })!;
    assert.ok(p.netPct > -1e-9 && p.netPct < 1e-9, "net zero");
    assert.ok(p.grossRatio > 1.019, "but the coin must still move +2% to break even");
  });

  it("refuses to plan without a SOL price rather than guessing one", () => {
    assert.equal(planProfitTarget({ notionalSol: 0.1, targetUsd: 2, solUsd: 0 }), null);
  });

  it("restates the cash target in SOL for the log", () => {
    const p = planProfitTarget({ notionalSol: 0.1, targetUsd: 3, solUsd: 150 })!;
    assert.ok(Math.abs(p.targetSol - 0.02) < 1e-12);
  });
});
