import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  walkForwardSplits, assertNoLookAhead, tradeStats, maxDrawdown, evInterval,
  brierScore, reliabilityBins, calibrationError, ablation, verdict,
  type Trade,
} from "@spr/trading";

/**
 * H14 — the harness that produces the edge / no-edge verdict.
 *
 * The tests that matter most are the two at the bottom: the harness must report
 * NO EDGE on pure noise, and must find a planted edge. A harness that only ever
 * finds edges is worthless, because it will find one in noise.
 */
function rng(seed: number) {
  let h = seed >>> 0;
  return () => {
    h += 0x6d2b79f5;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const trade = (over: Partial<Trade> = {}): Trade => ({
  mint: "M1", ts: 0, netReturn: 0, pnlSol: 0, ...over,
});

describe("walk-forward splits (H14: no look-ahead)", () => {
  const trades = Array.from({ length: 50 }, (_, i) =>
    trade({ mint: `m${i}`, ts: i, netReturn: 0.01, pnlSol: 0.01 }));

  it("every fold tests strictly LATER data than it trained on", () => {
    const folds = walkForwardSplits(trades, 4);
    assert.ok(folds.length > 0);
    assert.deepEqual(assertNoLookAhead(folds), [], "look-ahead detected");
  });

  it("training data expands and test blocks move forward", () => {
    const folds = walkForwardSplits(trades, 4);
    for (let i = 1; i < folds.length; i++) {
      assert.ok(folds[i]!.train.length > folds[i - 1]!.train.length);
      assert.ok(Math.min(...folds[i]!.test.map((t) => t.ts)) >
        Math.min(...folds[i - 1]!.test.map((t) => t.ts)));
    }
  });

  it("CATCHES look-ahead when it is present", () => {
    // A random K-fold on time series is the classic error: the guard must fire.
    const shuffled = [...trades].sort(() => 0.5 - 0.5);
    const bad = [{ index: 1, train: shuffled.slice(10, 40), test: shuffled.slice(0, 10) }];
    assert.ok(assertNoLookAhead(bad).length > 0, "look-ahead went undetected");
  });

  it("CATCHES a mint appearing on both sides of the boundary", () => {
    const shared = [
      { index: 1, train: [trade({ mint: "x", ts: 1 })], test: [trade({ mint: "x", ts: 2 })] },
    ];
    const problems = assertNoLookAhead(shared);
    assert.ok(problems.some((p) => /both train and test/.test(p.reason)));
  });

  it("refuses to split what it cannot split", () => {
    assert.deepEqual(walkForwardSplits(trades, 1), []);
    assert.deepEqual(walkForwardSplits(trades.slice(0, 2), 10), []);
    assert.deepEqual(walkForwardSplits([], 4), []);
  });
});

describe("trade statistics (H14)", () => {
  const trades: Trade[] = [
    trade({ mint: "a", ts: 1, netReturn: 0.5, pnlSol: 0.5 }),
    trade({ mint: "b", ts: 2, netReturn: -0.2, pnlSol: -0.2 }),
    trade({ mint: "c", ts: 3, netReturn: 0.1, pnlSol: 0.1 }),
    trade({ mint: "d", ts: 4, netReturn: -0.4, pnlSol: -0.4 }),
  ];

  it("reports the headline numbers the brief asks for", () => {
    const s = tradeStats(trades);
    assert.equal(s.n, 4);
    assert.equal(s.mints, 4);
    assert.equal(s.winRate, 0.5);
    assert.ok(Math.abs(s.avgWin - 0.3) < 1e-12);
    assert.ok(Math.abs(s.avgLoss - -0.3) < 1e-12);
    assert.ok(Math.abs(s.profitFactor - 1) < 1e-12);
    assert.ok(Math.abs(s.evPerTrade - 0) < 1e-12);
  });

  it("reports the median and trimmed mean beside the mean", () => {
    // A mean carried by one outlier cannot be traded; the median says so.
    const tail = [
      ...Array.from({ length: 19 }, (_, i) => trade({ mint: `m${i}`, ts: i, netReturn: -0.1, pnlSol: -0.1 })),
      trade({ mint: "winner", ts: 99, netReturn: 50, pnlSol: 50 }),
    ];
    const s = tradeStats(tail);
    assert.ok(s.evPerTrade > 2, "the mean looks spectacular");
    assert.ok(s.medianReturn < 0, "the median says the typical trade LOSES");
    assert.ok(s.trimmedMeanReturn < 0, "and so does the trimmed mean");
  });

  it("profit factor is Infinity with no losses, 0 with no wins", () => {
    assert.equal(tradeStats([trade({ pnlSol: 1, netReturn: 1 })]).profitFactor, Infinity);
    assert.equal(tradeStats([trade({ pnlSol: -1, netReturn: -1 })]).profitFactor, 0);
  });

  it("empty input does not divide by zero", () => {
    const s = tradeStats([]);
    assert.equal(s.n, 0);
    assert.equal(s.winRate, 0);
    assert.equal(s.evPerTrade, 0);
  });
});

describe("max drawdown (H14)", () => {
  it("measures peak to trough, in trade order", () => {
    const t = [
      trade({ ts: 1, pnlSol: 10 }), trade({ ts: 2, pnlSol: -4 }),
      trade({ ts: 3, pnlSol: -3 }), trade({ ts: 4, pnlSol: 8 }),
    ];
    const dd = maxDrawdown(t);
    assert.equal(dd.sol, 7, "peak 10 down to 3");
    assert.ok(Math.abs(dd.pct - 0.7) < 1e-12);
  });

  it("a monotonically rising curve has no drawdown", () => {
    assert.equal(maxDrawdown([trade({ ts: 1, pnlSol: 1 }), trade({ ts: 2, pnlSol: 1 })]).sol, 0);
  });

  it("counts a fall below the STARTING capital, not only below a later peak", () => {
    // Losing 5 straight away is a real 5 SOL drawdown: the peak starts at the
    // opening equity, so there is something to fall from from the first trade.
    const down = maxDrawdown([trade({ ts: 1, pnlSol: -5 }), trade({ ts: 2, pnlSol: 5 })]);
    assert.equal(down.sol, 5);
    // No percentage, though: the curve was never above water, so there is no
    // base to express it against.
    assert.equal(down.pct, 0);
  });

  it("order matters: the same trades in a different order drawdown differently", () => {
    const upFirst = maxDrawdown([
      trade({ ts: 1, pnlSol: 5 }), trade({ ts: 2, pnlSol: -5 }), trade({ ts: 3, pnlSol: 2 }),
    ]);
    const downFirst = maxDrawdown([
      trade({ ts: 1, pnlSol: -5 }), trade({ ts: 2, pnlSol: 5 }), trade({ ts: 3, pnlSol: 2 }),
    ]);
    assert.equal(upFirst.pct, 1, "gave back the entire gain");
    assert.equal(downFirst.pct, 0, "never above water, so no percentage drawdown");
  });
});

describe("uncertainty interval (H14)", () => {
  it("resamples MINTS, so correlated trades do not fake significance", () => {
    // 200 trades but only 2 mints: the honest interval must be wide.
    const clustered = Array.from({ length: 200 }, (_, i) =>
      trade({ mint: i < 100 ? "a" : "b", ts: i, netReturn: i < 100 ? 0.2 : -0.1 }));
    const interval = evInterval(clustered)!;
    assert.ok(interval.hi - interval.lo > 0.1, `interval ${interval.lo}..${interval.hi} is too narrow`);
    assert.ok(interval.lo < 0 && interval.hi > 0, "two mints cannot establish an edge");
  });

  it("returns null below two mints, where no interval is honest", () => {
    assert.equal(evInterval([trade({ mint: "only" })]), null);
    assert.equal(evInterval([]), null);
  });

  it("is deterministic for a given seed", () => {
    const t = Array.from({ length: 40 }, (_, i) => trade({ mint: `m${i}`, ts: i, netReturn: 0.01 }));
    assert.deepEqual(evInterval(t, { seed: 7 }), evInterval(t, { seed: 7 }));
  });
});

describe("calibration (H14)", () => {
  it("a perfect forecaster scores 0, a maximally wrong one scores 1", () => {
    assert.equal(brierScore([{ p: 1, outcome: true }, { p: 0, outcome: false }]), 0);
    assert.equal(brierScore([{ p: 0, outcome: true }, { p: 1, outcome: false }]), 1);
  });

  it("always saying 0.5 scores 0.25 — the no-information baseline", () => {
    const s = brierScore([
      { p: 0.5, outcome: true }, { p: 0.5, outcome: false },
      { p: 0.5, outcome: true }, { p: 0.5, outcome: false },
    ])!;
    assert.ok(Math.abs(s - 0.25) < 1e-12);
  });

  it("reliability bins show where a score is over-confident", () => {
    // Claims 0.9, delivers 0.5.
    const preds = Array.from({ length: 10 }, (_, i) => ({ p: 0.9, outcome: i < 5 }));
    const bins = reliabilityBins(preds);
    const bin = bins.find((b) => b.n > 0)!;
    assert.ok(Math.abs(bin.meanPredicted - 0.9) < 1e-12);
    assert.equal(bin.observedRate, 0.5);
    assert.ok(Math.abs(calibrationError(bins) - 0.4) < 1e-12);
  });

  it("empty bins are reported, not dropped", () => {
    const bins = reliabilityBins([{ p: 0.95, outcome: true }], 10);
    assert.equal(bins.length, 10, "a range the model never predicted is information");
    assert.equal(bins.filter((b) => b.n === 0).length, 9);
  });

  it("a well-calibrated score has near-zero calibration error", () => {
    const preds = [
      ...Array.from({ length: 100 }, (_, i) => ({ p: 0.3, outcome: i < 30 })),
      ...Array.from({ length: 100 }, (_, i) => ({ p: 0.7, outcome: i < 70 })),
    ];
    assert.ok(calibrationError(reliabilityBins(preds)) < 0.01);
  });
});

describe("ablation (H14)", () => {
  it("a delta whose interval straddles the baseline is NOT significant", () => {
    const noisy = Array.from({ length: 30 }, (_, i) =>
      trade({ mint: `m${i}`, ts: i, netReturn: i % 2 ? 0.3 : -0.28 }));
    const r = ablation("engineA", noisy, noisy.map((t) => ({ ...t, netReturn: t.netReturn - 0.005 })));
    assert.ok(r.delta > 0, "it looks like a small win");
    assert.equal(r.significant, false, "...but it is not distinguishable from noise");
  });

  it("a large consistent contribution IS significant", () => {
    const good = Array.from({ length: 60 }, (_, i) => trade({ mint: `m${i}`, ts: i, netReturn: 0.2 }));
    const bad = Array.from({ length: 60 }, (_, i) => trade({ mint: `n${i}`, ts: i, netReturn: -0.2 }));
    const r = ablation("engineB", good, bad);
    assert.ok(r.delta > 0.3);
    assert.equal(r.significant, true);
  });
});

describe("the verdict itself (H14)", () => {
  const many = (f: (i: number) => number) =>
    Array.from({ length: 300 }, (_, i) => trade({ mint: `m${i}`, ts: i, netReturn: f(i), pnlSol: f(i) }));

  it("reports NO EDGE on pure noise", () => {
    // The single most important test here. A harness that finds an edge in
    // noise would have certified the three strategies this repo already knows
    // are dead.
    const draw = rng(42);
    const noise = many(() => (draw() - 0.5) * 0.4);
    const stats = tradeStats(noise);
    const v = verdict({ oos: stats, interval: evInterval(noise), minTrades: 100, minMints: 50 });
    assert.equal(v.edge, false, `harness claimed an edge in noise: ${v.reason}`);
    assert.match(v.reason, /NO EDGE/);
  });

  it("reports NO EDGE when the mean is positive but the median is not", () => {
    // The lottery-ticket shape: one huge winner carries the mean.
    const tail = many((i) => (i === 0 ? 60 : -0.05));
    const v = verdict({ oos: tradeStats(tail), interval: evInterval(tail), minTrades: 100, minMints: 50 });
    assert.equal(v.edge, false);
    assert.equal(v.checks["median trade is not a loss"], false);
  });

  it("reports NO EDGE on too few trades, however good they look", () => {
    const few = Array.from({ length: 5 }, (_, i) => trade({ mint: `m${i}`, ts: i, netReturn: 0.5, pnlSol: 0.5 }));
    const v = verdict({ oos: tradeStats(few), interval: evInterval(few), minTrades: 100, minMints: 50 });
    assert.equal(v.edge, false);
    assert.equal(v.checks["enough trades"], false);
  });

  it("FINDS a planted edge — the harness is not merely pessimistic", () => {
    const draw = rng(7);
    const real = many(() => 0.06 + (draw() - 0.5) * 0.08);
    const v = verdict({ oos: tradeStats(real), interval: evInterval(real), minTrades: 100, minMints: 50 });
    assert.equal(v.edge, true, `missed a real edge: ${v.reason}`);
  });

  it("every check must hold — one failure is no edge", () => {
    const draw = rng(9);
    const real = many(() => 0.06 + (draw() - 0.5) * 0.08);
    const v = verdict({ oos: tradeStats(real), interval: null, minTrades: 100, minMints: 50 });
    assert.equal(v.edge, false, "a missing interval cannot pass");
  });
});
