import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { scorePolicy, simulateExit, type ExitPolicy, type PathMark } from "@/lib/paper/exit-policy-sim";

const BASE: ExitPolicy = {
  name: "balanced",
  tpPct: 0.28,
  slPct: 0.12,
  maxHoldMs: 45 * 60_000,
  trailArmPct: 0.15,
  trailStopPct: 0.08,
  stagnationMs: 18 * 60_000,
};

/** A path that never moves: the 81% case. */
function flatPath(minutes: number): PathMark[] {
  const out: PathMark[] = [];
  for (let s = 0; s <= minutes * 60; s += 30) out.push({ ageS: s, pct: -0.03, peakPct: -0.02, lastTradeAgeS: 5 });
  return out;
}

/**
 * Flat for `slowMin`, then runs to `peak` and gives 10% back. The pullback
 * matters: a monotonically rising path never trails, because pct == peak on
 * every mark.
 */
function slowWinnerPath(slowMin: number, peak: number): PathMark[] {
  const out: PathMark[] = [];
  let p = 0;
  let peakSoFar = 0;
  let risen = false;
  for (let s = 0; s <= 25 * 60; s += 30) {
    if (s > slowMin * 60) {
      if (!risen) {
        p = Math.min(peak, p + 0.02);
        if (p >= peak) risen = true;
      } else {
        p -= 0.02; // give some back so an armed trail can fire
      }
    }
    peakSoFar = Math.max(peakSoFar, p);
    out.push({ ageS: s, pct: p, peakPct: peakSoFar, lastTradeAgeS: 3 });
  }
  return out;
}

/** In mild profit but under the trail arm, over a short window. */
function mildPath(minutes: number, pct: number): PathMark[] {
  const out: PathMark[] = [];
  for (let s = 0; s <= minutes * 60; s += 30) out.push({ ageS: s, pct, peakPct: pct, lastTradeAgeS: 4 });
  return out;
}

describe("simulateExit", () => {
  it("a never-mover is cut by the stagnation rule at its configured age", () => {
    const r = simulateExit(flatPath(45), BASE);
    assert.equal(r.reason, "stagnation");
    assert.equal(r.exitAgeS, 18 * 60);
  });

  it("a tighter cut frees the same never-mover much earlier", () => {
    const scalp: ExitPolicy = { ...BASE, name: "scalp", stagnationMs: 5 * 60_000, stagnationMaxPeakPct: 0.03 };
    const r = simulateExit(flatPath(45), scalp);
    assert.equal(r.reason, "stagnation");
    assert.equal(r.exitAgeS, 5 * 60);
  });

  it("stop-loss fires before any time-based rule", () => {
    const path: PathMark[] = [
      { ageS: 0, pct: 0, peakPct: 0, lastTradeAgeS: 2 },
      { ageS: 30, pct: -0.2, peakPct: 0, lastTradeAgeS: 2 },
    ];
    const r = simulateExit(path, BASE);
    assert.equal(r.reason, "sl");
    assert.equal(r.exitAgeS, 30);
  });

  it("a slow winner survives the 18-min cut but a 5-min cut clips it", () => {
    const path = slowWinnerPath(8, 0.4);
    // It is still under the +15% ceiling at 18 min? No — by then it has run, so it is spared.
    assert.equal(simulateExit(path, BASE).reason, "trail");
    const early: ExitPolicy = { ...BASE, name: "cut5", stagnationMs: 5 * 60_000, stagnationMaxPeakPct: 0.03 };
    const clipped = simulateExit(path, early);
    assert.equal(clipped.reason, "stagnation");
    assert.equal(clipped.exitAgeS, 5 * 60);
  });

  it("deadFlow cuts a stalled coin that is not in profit, and spares one that is", () => {
    const stalled: PathMark[] = [{ ageS: 60, pct: -0.02, peakPct: 0.01, lastTradeAgeS: 400 }];
    const p: ExitPolicy = { ...BASE, name: "dead", deadFlowSec: 300 };
    assert.equal(simulateExit(stalled, p).reason, "dead_flow");
    // Same stall, but in profit → left to the normal ladder.
    const winning: PathMark[] = [{ ageS: 60, pct: 0.05, peakPct: 0.05, lastTradeAgeS: 400 }];
    assert.equal(simulateExit(winning, p).reason, null);
  });

  it("holds when nothing triggers within the recorded path", () => {
    // +5% for 10 min: under the trail arm, past no age threshold.
    const r = simulateExit(mildPath(10, 0.05), BASE);
    assert.equal(r.exitAgeS, null);
    assert.equal(r.reason, null);
  });

  it("a flat position IS cut at the baseline's 18 min, so 'held' is never accidental", () => {
    const r = simulateExit(mildPath(25, 0.01), BASE);
    assert.equal(r.reason, "stagnation");
    assert.equal(r.exitAgeS, 18 * 60);
  });

  it("an empty path yields no exit rather than throwing", () => {
    const r = simulateExit([], BASE);
    assert.equal(r.exitAgeS, null);
    assert.equal(r.pctAtExit, null);
  });
});

describe("scorePolicy", () => {
  const trades = [
    { sizeSol: 0.03, actualPnlSol: -0.001, actualHoldMin: 45, path: flatPath(45) },
    { sizeSol: 0.03, actualPnlSol: 0.012, actualHoldMin: 20, path: slowWinnerPath(8, 0.4) },
  ];

  it("reports slot-minutes so freed capacity is visible", () => {
    const base = scorePolicy(trades, BASE);
    const scalp = scorePolicy(trades, { ...BASE, name: "scalp", stagnationMs: 5 * 60_000, stagnationMaxPeakPct: 0.03 });
    assert.ok(scalp.slotMinutes < base.slotMinutes, "a tighter cut must free slot time");
  });

  it("counts winners clipped and the P&L given up", () => {
    const scalp = scorePolicy(trades, { ...BASE, name: "scalp", stagnationMs: 5 * 60_000, stagnationMaxPeakPct: 0.03 });
    // The slow winner is exited at 5 min while flat, below what it actually made.
    assert.ok(scalp.winnersClipped >= 1);
    assert.ok(scalp.pnlGivenUp > 0);
  });

  it("a trade with no simulated exit keeps its actual outcome, not an invented one", () => {
    const held = [{ sizeSol: 0.03, actualPnlSol: 0.02, actualHoldMin: 30, path: mildPath(10, 0.05) }];
    const s = scorePolicy(held, BASE);
    assert.equal(s.pnlSol, 0.02);
    assert.equal(s.avgHoldMin, 30);
  });
});
