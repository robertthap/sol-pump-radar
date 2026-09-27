import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_ON_CURVE_ENTRY_V_SOL,
  forceCloseCandidateVSol,
  isOffCurvePosition,
  selectExitPrice,
} from "@/lib/pricing/exit-price";
import { impliedReturn, safeExitVSol } from "@/lib/paper/close-price";

const failed = { phase: "unknown" as const, reason: "RPC unavailable" };

describe("selectExitPrice — missing data never switches a graduated position to the curve", () => {
  // The real incident. Position 1411: a flat ~$60M coin entered at 4245.68 on the
  // mcap basis. One tick had no price data and the curve resolver said 24.14.
  it("position 1411: a failed read on a graduated position is unpriced, not -100%", () => {
    const old = impliedReturn(4245.68, 24.14);
    assert.ok(old != null && old < -0.99, "the old path read this as a total loss");

    const r = selectExitPrice({ entryVSol: 4245.68, graduatedSeen: true, live: failed, curveVSol: 24.14 });
    assert.equal(r.priced, false);
    assert.equal(r.offCurve, true);
  });

  it("an entry above the curve maximum is off-curve even before any tick saw it graduate", () => {
    const r = selectExitPrice({ entryVSol: 4245.68, graduatedSeen: false, live: failed, curveVSol: 24.14 });
    assert.equal(r.priced, false);
    assert.equal(r.offCurve, true);
  });

  it("a graduated coin is priced from its pool, ignoring any curve value", () => {
    const r = selectExitPrice({
      entryVSol: 115.43,
      graduatedSeen: false,
      live: { phase: "graduated", vSol: 107.2 },
      curveVSol: 115,
    });
    assert.deepEqual(r, { priced: true, vSol: 107.2, offCurve: true });
  });

  it("a graduated reading without a usable pool price is unpriced", () => {
    const r = selectExitPrice({
      entryVSol: 60,
      graduatedSeen: false,
      live: { phase: "graduated", vSol: Number.NaN },
      curveVSol: 113,
    });
    assert.equal(r.priced, false);
    assert.equal(r.offCurve, true);
  });

  it("an on-curve reading for a position entered above the curve's range is unpriced", () => {
    const r = selectExitPrice({
      entryVSol: 4245.68,
      graduatedSeen: false,
      live: { phase: "curve", vSol: 40 },
      curveVSol: 40,
    });
    assert.equal(r.priced, false);
  });
});

describe("selectExitPrice — on-curve positions", () => {
  it("uses the on-chain curve price", () => {
    const r = selectExitPrice({ entryVSol: 60, graduatedSeen: false, live: { phase: "curve", vSol: 72 }, curveVSol: 70 });
    assert.deepEqual(r, { priced: true, vSol: 72, offCurve: false });
  });

  it("falls back to the ingested curve price only when the live read failed", () => {
    const r = selectExitPrice({ entryVSol: 60, graduatedSeen: false, live: failed, curveVSol: 70 });
    assert.deepEqual(r, { priced: true, vSol: 70, offCurve: false });
  });

  it("no price at all is unpriced (the existing no-price path)", () => {
    for (const curveVSol of [null, 0, -3, Number.NaN]) {
      const r = selectExitPrice({ entryVSol: 60, graduatedSeen: false, live: failed, curveVSol });
      assert.equal(r.priced, false);
      assert.equal(r.offCurve, false);
    }
  });
});

describe("isOffCurvePosition — entry-price boundary", () => {
  it("a fill at the curve's end plus slippage is not off-curve by price alone", () => {
    assert.equal(isOffCurvePosition({ entryVSol: 115.45, graduatedSeen: false, graduatedNow: false }), false);
  });

  it("the threshold is exclusive", () => {
    const at = { entryVSol: MAX_ON_CURVE_ENTRY_V_SOL, graduatedSeen: false, graduatedNow: false };
    assert.equal(isOffCurvePosition(at), false);
    assert.equal(isOffCurvePosition({ ...at, entryVSol: MAX_ON_CURVE_ENTRY_V_SOL + 0.01 }), true);
  });

  it("an unusable entry price does not make a position off-curve on its own", () => {
    assert.equal(isOffCurvePosition({ entryVSol: Number.NaN, graduatedSeen: false, graduatedNow: false }), false);
  });
});

describe("forceCloseCandidateVSol — force-closes book on the entry's own basis", () => {
  it("off-curve: uses the last exit mark, so 1411 would close near its real -2% instead of -101%", () => {
    const lastMark = 4245.68 * Math.sqrt(60_286_000 / 59_514_000);
    const candidate = forceCloseCandidateVSol({ offCurve: true, lastMarkExitVSol: lastMark, storedCurrentPrice: 24.14 });
    assert.equal(candidate, lastMark);
    const safe = safeExitVSol({ entryVSol: 4245.68, candidateVSol: candidate });
    const implied = impliedReturn(4245.68, safe.exitVSol)!;
    assert.ok(implied > -0.05 && implied < 0.05, `booked ${implied}`);
  });

  it("off-curve without a usable mark: null, which safeExitVSol closes flat at entry", () => {
    for (const lastMarkExitVSol of [undefined, null, "4245", 0, Number.NaN]) {
      const candidate = forceCloseCandidateVSol({ offCurve: true, lastMarkExitVSol, storedCurrentPrice: 24.14 });
      assert.equal(candidate, null);
      assert.equal(safeExitVSol({ entryVSol: 4245.68, candidateVSol: candidate }).exitVSol, 4245.68);
    }
  });

  it("on-curve: keeps the stored mark, as before", () => {
    assert.equal(forceCloseCandidateVSol({ offCurve: false, lastMarkExitVSol: 99, storedCurrentPrice: 48 }), 48);
    assert.equal(forceCloseCandidateVSol({ offCurve: false, lastMarkExitVSol: 99, storedCurrentPrice: null }), null);
  });
});
