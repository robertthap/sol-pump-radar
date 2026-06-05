import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { curveValueRatio, curveRealizedPnlSol, curveUnrealizedPnlSol } from "@spr/trading";
import { paperPnlSol } from "@/lib/paper/math";

/**
 * Regression guard for the A1 PnL-model unification. The paper executor books
 * realized/unrealized PnL on the bonding curve (value ∝ vSol²) via these helpers,
 * which MUST agree with the exit-decision/display math in lib/paper/math.ts
 * (paperPnlSol). Previously the executor booked linearly in vSol (value ∝ vSol),
 * so a TP that triggered at +44% booked only +20%.
 */
describe("curve PnL helpers (A1 unification)", () => {
  it("value scales as the square of the vSol ratio", () => {
    assert.ok(Math.abs(curveValueRatio(30, 36) - 1.44) < 1e-9); // 1.2x vSol → 1.44x value
    assert.ok(Math.abs(curveValueRatio(30, 60) - 4) < 1e-9); //    2x vSol → 4x value
    assert.ok(Math.abs(curveValueRatio(30, 15) - 0.25) < 1e-9); // 0.5x vSol → 0.25x value
    assert.equal(curveValueRatio(30, 30), 1); // flat
  });

  it("guards non-positive entry / invalid current (flat = 1)", () => {
    assert.equal(curveValueRatio(0, 50), 1);
    assert.equal(curveValueRatio(-5, 50), 1);
    assert.equal(curveValueRatio(30, Number.NaN), 1);
    assert.equal(curveValueRatio(30, -1), 1);
  });

  it("realized PnL squares the ratio (the bug: would have been +20%, not +44%)", () => {
    // entry vSol 30 → exit vSol 36 (1.2x). Curve value = 1.44 → +44% on a 1 SOL basis.
    const pnl = curveRealizedPnlSol(30, 36, 1, 0);
    assert.ok(Math.abs(pnl - 0.44) < 1e-9, `pnl=${pnl}`);
    // the OLD linear booking would have produced (36-30)/30 = +0.20 — explicitly NOT this.
    assert.ok(pnl > 0.4, "must reflect the quadratic curve, not linear vSol");
  });

  it("realized PnL subtracts fees from the curve value", () => {
    assert.ok(Math.abs(curveRealizedPnlSol(30, 36, 1, 0.01) - 0.43) < 1e-9);
  });

  it("unrealized PnL uses the same basis (a 0.8x vSol = -36% of value)", () => {
    // 0.8^2 = 0.64 → -0.36 on a 2 SOL cost basis = -0.72 SOL.
    assert.ok(Math.abs(curveUnrealizedPnlSol(30, 24, 2) + 0.72) < 1e-9);
  });

  it("booking agrees with the exit-decision model (paperPnlSol) for any vSol move", () => {
    for (const [e, c] of [
      [30, 36],
      [30, 90],
      [45, 20],
      [115, 60],
    ] as const) {
      const decision = paperPnlSol({
        sizeSol: 1,
        entryVSol: e,
        currentVSol: c,
        pumpFeesPct: 0,
        paperSlippagePct: 0,
      });
      // With zero friction, the decision ratio === the booking value ratio.
      assert.ok(Math.abs(curveValueRatio(e, c) - decision.ratio) < 1e-9, `${e}->${c}`);
      assert.ok(Math.abs(curveRealizedPnlSol(e, c, 1, 0) - decision.pnlSol) < 1e-9, `${e}->${c}`);
    }
  });

  it("the √mcapRatio exit override reproduces the real mcap ratio under curve booking", () => {
    // auto-trader feeds override = entry · √mcapRatio so the curve close (which
    // squares the ratio) books exactly the real mcap ratio. Here mcapRatio = 3.
    const entry = 30;
    const mcapRatio = 3;
    const override = entry * Math.sqrt(mcapRatio);
    assert.ok(Math.abs(curveValueRatio(entry, override) - mcapRatio) < 1e-9);
    // → +200% on a 1 SOL basis, matching a 3x market cap (pnlFromMcap pct = 2).
    assert.ok(Math.abs(curveRealizedPnlSol(entry, override, 1, 0) - 2) < 1e-9);
  });
});
