import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { planMintsToEvaluateCore } from "@/lib/intelligence/eval-scheduler-plan";

describe("planMintsToEvaluateCore", () => {
  it("prioritizes top rank before launch hot", () => {
    const mints = ["mint0", "mint1", "mint2", "mint3", "mint4"];
    const cross = new Map([
      ["mint0", 1],
      ["mint1", 0.85],
      ["mint2", 0.7],
      ["mint3", 0.55],
      ["mint4", 0.2],
    ]);
    const plan = planMintsToEvaluateCore(
      mints,
      new Set(mints),
      cross,
      new Map(),
      {
        topRank: 2,
        skipUnchangedMs: 0,
        maxEvaluate: 3,
        maxLaunchHot: 2,
        launchHotMints: ["mint4"],
        continuationHotMints: ["mint3"],
        lastEvalAt: new Map(),
      },
      Date.now(),
    );
    assert.ok(plan.mints.includes("mint0"));
    assert.ok(plan.mints.includes("mint1"));
    assert.equal(plan.reasons.topRank, 2);
  });
});
