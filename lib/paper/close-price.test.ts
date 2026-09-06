import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { impliedReturn, safeExitVSol, MAX_FORCE_CLOSE_ABS_PCT } from "@/lib/paper/close-price";

describe("safeExitVSol — the fabricated-profit guard", () => {
  // The real incident. Position 1289: entry ~74 vSol (from stopLoss 64.918 at -12%),
  // mark-to-market stored 785 vSol on the MCAP basis, and the sweep booked +11,115%
  // as +26.676 SOL on a 0.24 SOL position.
  it("refuses position 1289's mark and closes flat instead", () => {
    const r = safeExitVSol({ entryVSol: 74, candidateVSol: 785.19 });
    assert.equal(r.mismatch, true);
    assert.equal(r.exitVSol, 74, "must book at entry, i.e. 0 P&L");
    assert.ok(r.impliedPct != null && r.impliedPct > 100, "the candidate implied >10,000%");
    assert.match(r.reason ?? "", /basis mismatch/);
  });

  it("refuses position 1252's mark (the fake +68.6 SOL)", () => {
    const r = safeExitVSol({ entryVSol: 74, candidateVSol: 2513.09 });
    assert.equal(r.mismatch, true);
    assert.equal(r.exitVSol, 74);
  });

  it("a legitimate 2x move is still booked, not suppressed", () => {
    // 2x vSol = 4x value = +300%, well inside the cap.
    const r = safeExitVSol({ entryVSol: 100, candidateVSol: 200 });
    assert.equal(r.mismatch, false);
    assert.equal(r.exitVSol, 200);
  });

  it("a total loss is still booked — the cap is not symmetric in effect", () => {
    // Down 99% in value: implied -0.99, inside the cap.
    const r = safeExitVSol({ entryVSol: 100, candidateVSol: 10 });
    assert.equal(r.mismatch, false);
    assert.equal(r.exitVSol, 10);
  });

  it("closes flat when no price is known rather than inventing one", () => {
    for (const c of [null, undefined, 0, -5, Number.NaN]) {
      const r = safeExitVSol({ entryVSol: 50, candidateVSol: c as number | null });
      assert.equal(r.exitVSol, 50);
      assert.equal(r.mismatch, false, "absent price is not a mismatch, just unknown");
    }
  });

  it("the boundary is inclusive-safe: exactly at the cap still books", () => {
    // implied = cap exactly -> allowed; just past it -> rejected.
    const atCap = Math.sqrt(1 + MAX_FORCE_CLOSE_ABS_PCT) * 100;
    assert.equal(safeExitVSol({ entryVSol: 100, candidateVSol: atCap }).mismatch, false);
    assert.equal(safeExitVSol({ entryVSol: 100, candidateVSol: atCap * 1.01 }).mismatch, true);
  });

  it("an unusable entry price closes flat rather than dividing by it", () => {
    const r = safeExitVSol({ entryVSol: 0, candidateVSol: 500 });
    assert.equal(r.exitVSol, 0);
    assert.equal(r.mismatch, false);
  });
});

describe("impliedReturn", () => {
  it("squares the vSol ratio (curve value model)", () => {
    assert.equal(impliedReturn(100, 200), 3); // 2x price = 4x value = +300%
    assert.equal(impliedReturn(100, 100), 0);
  });
  it("null on unusable input", () => {
    assert.equal(impliedReturn(0, 100), null);
    assert.equal(impliedReturn(100, 0), null);
    assert.equal(impliedReturn(Number.NaN, 100), null);
  });
});
