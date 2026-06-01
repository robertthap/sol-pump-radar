import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { regimeSizedSol } from "@/lib/risk/position-sizing";
import { evaluateKillSwitch } from "@/lib/risk/kill-switch";

describe("regimeSizedSol", () => {
  it("neutral regime (1.0) keeps base size", () => {
    assert.equal(regimeSizedSol(0.05, 1.0), 0.05);
  });
  it("high-rug regime (1.25) shrinks size", () => {
    assert.ok(regimeSizedSol(0.05, 1.25) < 0.05);
  });
  it("risk-on regime (0.9) grows size, capped at 1.2x", () => {
    const s = regimeSizedSol(0.05, 0.9);
    assert.ok(s > 0.05 && s <= 0.05 * 1.2 + 1e-9);
  });
  it("guards invalid inputs", () => {
    assert.equal(regimeSizedSol(0, 1), 0);
    assert.equal(regimeSizedSol(0.05, 0), 0.05);
  });
});

describe("evaluateKillSwitch", () => {
  const base = { dailyLossSol: 0, maxDailyLossSol: 0.3, consecutiveLosses: 0, maxConsecutiveLosses: 5 };

  it("does not halt when healthy", () => {
    assert.equal(evaluateKillSwitch(base).halt, false);
  });
  it("halts on daily-loss cap", () => {
    const r = evaluateKillSwitch({ ...base, dailyLossSol: 0.31 });
    assert.equal(r.halt, true);
    assert.equal(r.scope, "daily_loss");
  });
  it("halts on a consecutive-loss streak", () => {
    const r = evaluateKillSwitch({ ...base, consecutiveLosses: 5 });
    assert.equal(r.halt, true);
    assert.equal(r.scope, "consecutive");
  });
  it("halts during an active cooldown", () => {
    const r = evaluateKillSwitch({ ...base, cooldownUntilMs: 10_000, nowMs: 5_000 });
    assert.equal(r.halt, true);
    assert.equal(r.scope, "cooldown");
  });
  it("resumes after the cooldown expires", () => {
    const r = evaluateKillSwitch({ ...base, cooldownUntilMs: 10_000, nowMs: 11_000 });
    assert.equal(r.halt, false);
  });
});
