import test from "node:test";
import assert from "node:assert/strict";
import { researchPreset, researchStrategy } from "./bot-config";
import { STRATEGIES } from "./catalog";

test("research presets override every inherited exit, keep frozen sizes and distinguish all three bots", () => {
  for (const id of ["graduation","curveLadder","scaleIn"] as const) {
    const p = {...{tp1Pct:0.15,stopLossPct:0.12,trailingStopPct:0.08}, ...researchPreset(id)};
    assert.equal(p.researchStrategy,id);
    assert.equal(p.sizeSol,STRATEGIES[id].size);
    assert.equal(p.maxHoldMinutes,STRATEGIES[id].hold/60);
    assert.equal(p.tp1Pct,0); assert.equal(p.stopLossPct,0); assert.equal(p.trailingStopPct,0);
    assert.equal(p.researchExecution,"BASE");
    assert.equal(p.requireCurveLadder,false);
  }
});
test("signal-source and object prototype names are never research strategies", () => {
  for (const id of ["launch","hybrid","profit","__proto__","toString",null]) assert.equal(researchStrategy(id),null);
});
