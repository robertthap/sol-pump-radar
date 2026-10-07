import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { curveExitSettlement, curveValueRatio } from "@spr/trading";

/**
 * H02 — the entry fee must not be refunded at exit.
 *
 * The fee is skimmed before the order reaches the pool, so only
 * (cost basis − entry fee) ever compounds. Settling against the full cost basis
 * hands the entry fee back, which halved the modelled round-trip cost.
 */
const FEE_BPS = 100; // 1% per side
const rate = FEE_BPS / 10_000;

const settle = (over: Partial<Parameters<typeof curveExitSettlement>[0]> = {}) =>
  curveExitSettlement({
    entryVSol: 100,
    exitVSol: 100,
    costBasisSol: 1,
    entryFeeSol: 1 * rate,
    feeBps: FEE_BPS,
    priorityFeeSol: 0,
    feesEnabled: true,
    ...over,
  });

describe("curveExitSettlement (H02)", () => {
  it("a flat round trip costs the entry fee plus the exit fee on what is left", () => {
    const s = settle();
    const expected = -(1 * rate) - 1 * (1 - rate) * rate; // -0.0199
    assert.ok(Math.abs(s.pnlSol - expected) < 1e-12, `pnl ${s.pnlSol}, expected ${expected}`);
    // The regression this guards: the old math returned exactly -rate.
    assert.ok(s.pnlSol < -rate, "entry fee was refunded at exit");
  });

  it("only the deployed capital compounds", () => {
    const s = settle({ exitVSol: 200 }); // 2x vSol -> 4x value
    assert.ok(Math.abs(s.deployedSol - (1 - rate)) < 1e-12);
    assert.ok(Math.abs(s.grossOutSol - (1 - rate) * 4) < 1e-12);
    assert.equal(curveValueRatio(100, 200), 4);
  });

  it("cash in equals gross out minus both fees, and pnl is against the FULL basis", () => {
    const s = settle({ exitVSol: 150, priorityFeeSol: 0.0005 });
    assert.ok(Math.abs(s.cashInSol - (s.grossOutSol - s.exitFeeSol - s.priorityFeeSol)) < 1e-12);
    assert.ok(Math.abs(s.pnlSol - (s.cashInSol - 1)) < 1e-12);
  });

  it("a costless flat round trip returns exactly zero", () => {
    const s = settle({ entryFeeSol: 0, feesEnabled: false, priorityFeeSol: 0.0005 });
    assert.equal(s.pnlSol, 0);
    assert.equal(s.exitFeeSol, 0);
    assert.equal(s.priorityFeeSol, 0);
  });

  it("two half slices settle to the same total as one whole", () => {
    const whole = settle({ exitVSol: 130 });
    const halves = [0.5, 0.5].map((f) =>
      settle({ exitVSol: 130, costBasisSol: f, entryFeeSol: f * rate }),
    );
    const sum = halves.reduce((a, s) => a + s.pnlSol, 0);
    assert.ok(Math.abs(sum - whole.pnlSol) < 1e-12, `${sum} vs ${whole.pnlSol}`);
  });

  it("a total loss cannot cost more than the position", () => {
    const s = settle({ exitVSol: 0 });
    assert.ok(Math.abs(s.pnlSol + 1) < 1e-12, "losing everything costs exactly the basis");
  });

  it("an entry fee larger than the basis cannot deploy negative capital", () => {
    const s = settle({ entryFeeSol: 5 });
    assert.equal(s.deployedSol, 0);
    assert.equal(s.grossOutSol, 0);
  });
});
