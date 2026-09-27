import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CURVE_LADDER,
  GRADUATION_SOL,
  LADDER_LEVELS,
  VIRTUAL_SOL_OFFSET,
  curveProgress,
  isStandardCurveRow,
  ladderSignal,
  levelsCrossed,
  minRealSolGain120s,
  minimumFirableLevel,
  realSolFromVSol,
  unreachableLevels,
  type LadderFeatures,
} from "@/lib/trade/curve-ladder";

/** A crossing that passes all three conditions, at a rung that can actually fire. */
function passing(over: Partial<LadderFeatures> = {}): LadderFeatures {
  return {
    level: 30,
    crossingTradeSol: 1.0,
    buyerConcentration30s: 0.2,
    progressRate120s: 0.004,
    ...over,
  };
}

describe("curve arithmetic", () => {
  it("recovers real SOL from the virtual reserve our ingest stores", () => {
    assert.equal(realSolFromVSol(30), 0, "a fresh curve has paid in nothing");
    assert.equal(realSolFromVSol(55), 25);
    // Graduation sits at 85.005 real, i.e. 115.005 virtual.
    assert.ok(Math.abs(realSolFromVSol(VIRTUAL_SOL_OFFSET + GRADUATION_SOL) - GRADUATION_SOL) < 1e-9);
  });

  it("progress is the fraction of the way to graduation", () => {
    assert.equal(curveProgress(0), 0);
    assert.ok(Math.abs(curveProgress(GRADUATION_SOL) - 1) < 1e-12);
  });
});

describe("the structural defect — the point of this replication", () => {
  // 0.00256623 /s x 120 s x 85.005 SOL = 26.18 SOL of gain required.
  it("condition 3 demands a ~26.2 SOL gain in two minutes", () => {
    const need = minRealSolGain120s();
    assert.ok(need > 26.1 && need < 26.3, `expected ~26.18, got ${need}`);
  });

  it("levels 5 through 25 can never fire — a curve at 25 cannot have gained 26.2", () => {
    assert.deepEqual(unreachableLevels(), [5, 10, 15, 20, 25]);
  });

  it("the lowest rung that can fire is 30", () => {
    assert.equal(minimumFirableLevel(), 30);
  });

  it("five of nine rungs are dead, so an unstratified control is measuring level, not skill", () => {
    assert.equal(unreachableLevels().length, 5);
    assert.equal(LADDER_LEVELS.length, 9);
  });

  // The bound is derived, so it must move if the threshold moves. This is what
  // stops the impossibility from silently becoming a stale comment.
  it("the bound tracks the threshold rather than being hardcoded", () => {
    const need = minRealSolGain120s();
    assert.ok(
      Math.abs(need - CURVE_LADDER.minProgressRate120s * 120 * GRADUATION_SOL) < 1e-12,
      "minRealSolGain120s must be computed from the live threshold",
    );
  });

  it("flags an impossible rung on the signal itself, with the arithmetic in the reason", () => {
    const s = ladderSignal(passing({ level: 15, progressRate120s: 0.001 }));
    assert.equal(s.fire, false);
    assert.equal(s.structurallyImpossible, true);
    assert.match(s.reason, /unreachable at level 15/);
    assert.match(s.reason, /26\.1[0-9]/);
  });
});

describe("ladderSignal", () => {
  it("fires when all three conditions hold", () => {
    const s = ladderSignal(passing());
    assert.equal(s.fire, true);
    assert.deepEqual(s.checks, { crossingSize: true, concentration: true, progressRate: true });
  });

  it("rejects a crossing trade that is too large, and names it", () => {
    const s = ladderSignal(passing({ crossingTradeSol: 3.0 }));
    assert.equal(s.fire, false);
    assert.equal(s.checks.crossingSize, false);
    assert.match(s.reason, /crossing trade 3\.00 SOL/);
  });

  it("rejects buying concentrated in one wallet", () => {
    const s = ladderSignal(passing({ buyerConcentration30s: 0.5 }));
    assert.equal(s.fire, false);
    assert.match(s.reason, /concentration 0\.500/);
  });

  // The specification is explicit: a data gap is DATA_UNAVAILABLE, never a zero.
  it("treats missing concentration as a FAILED condition, not a passed one", () => {
    const s = ladderSignal(passing({ buyerConcentration30s: null }));
    assert.equal(s.fire, false, "unknown flow must never read as clean flow");
    assert.match(s.reason, /unavailable/);
  });

  it("treats a missing progress rate as a FAILED condition", () => {
    const s = ladderSignal(passing({ progressRate120s: null }));
    assert.equal(s.fire, false);
    assert.match(s.reason, /unavailable/);
  });

  it("applies the thresholds as inclusive/exclusive exactly as specified", () => {
    // size and concentration are <=, rate is strictly >.
    assert.equal(ladderSignal(passing({ crossingTradeSol: CURVE_LADDER.maxCrossingTradeSol })).fire, true);
    assert.equal(
      ladderSignal(passing({ buyerConcentration30s: CURVE_LADDER.maxBuyerConcentration30s })).fire,
      true,
    );
    assert.equal(
      ladderSignal(passing({ progressRate120s: CURVE_LADDER.minProgressRate120s })).fire,
      false,
      "the rate threshold is strictly greater-than",
    );
  });
});

describe("levelsCrossed", () => {
  it("returns the rung a trade carried the curve over", () => {
    assert.deepEqual(levelsCrossed(4.2, 6.1), [5]);
  });

  it("a large buy vaulting several rungs opens an episode at each", () => {
    assert.deepEqual(levelsCrossed(3, 32), [5, 10, 15, 20, 25, 30]);
  });

  it("does not re-arm a rung already below the curve", () => {
    assert.deepEqual(levelsCrossed(31, 35), []);
  });

  it("a sell moving the curve down crosses nothing", () => {
    assert.deepEqual(levelsCrossed(40, 22), []);
  });

  it("landing exactly on a rung counts as crossing it", () => {
    assert.deepEqual(levelsCrossed(9.5, 10), [10]);
  });
});

describe("isStandardCurveRow", () => {
  it("accepts a trade inside the curve's arithmetic range", () => {
    assert.equal(isStandardCurveRow(55, 0.4), true);
    assert.equal(isStandardCurveRow(VIRTUAL_SOL_OFFSET, 0.1), true);
  });

  // Our feed really does carry these: v_sol_after up to 3390 against a 115 ceiling.
  it("rejects a graduated coin priced off market cap", () => {
    assert.equal(isStandardCurveRow(3390.53, 0.4), false);
    assert.equal(isStandardCurveRow(150, 0.4), false);
  });

  it("rejects a non-SOL-quoted curve, which reports zero SOL", () => {
    assert.equal(isStandardCurveRow(55, 0), false);
    assert.equal(isStandardCurveRow(55, null), false);
  });

  it("rejects a reserve below the virtual floor, which is not a standard curve", () => {
    assert.equal(isStandardCurveRow(0, 0.4), false);
    assert.equal(isStandardCurveRow(12, 0.4), false);
  });
});
