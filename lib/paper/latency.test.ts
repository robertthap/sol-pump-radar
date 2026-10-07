import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  percentiles, latencyProfile, fillLatency, sampleFillLatencyMs,
} from "@spr/trading";

/**
 * M05 — paper fills must use MEASURED latency, not the 80–280ms default.
 *
 * That range was a guess, and it is the single number deciding how much of a
 * move a paper fill captures. Too low and every result is optimistic in exactly
 * the way that makes a dead strategy look alive.
 */
describe("percentiles (M05)", () => {
  it("reports values that actually occurred, not interpolations", () => {
    const p = percentiles([10, 20, 30, 40, 50, 60, 70, 80, 90, 100])!;
    assert.ok([10, 20, 30, 40, 50, 60, 70, 80, 90, 100].includes(p.p50));
    assert.equal(p.n, 10);
    assert.ok(p.p50 <= p.p90 && p.p90 <= p.p99);
  });

  it("a single sample is its own p50, p90 and p99", () => {
    assert.deepEqual(percentiles([42]), { p50: 42, p90: 42, p99: 42, n: 1 });
  });

  it("no samples means NO percentile, not zero", () => {
    // Zero would read as an instant fill — the most optimistic possible lie.
    assert.equal(percentiles([]), null);
    assert.equal(percentiles([NaN, -1, Infinity]), null);
  });

  it("discards impossible samples rather than letting them skew the tail", () => {
    const p = percentiles([10, 20, NaN, -5, 30])!;
    assert.equal(p.n, 3);
  });
});

describe("latency profile and bottleneck (M05)", () => {
  const samples = {
    ingest: [1, 2, 1, 2, 1],
    persist: [40, 60, 50, 55, 45],
    decide: [5, 6, 5, 7, 5],
    submit: [20, 25, 22, 24, 21],
  };

  it("names the slowest stage as the bottleneck", () => {
    const p = latencyProfile(samples);
    assert.equal(p.bottleneck?.stage, "persist");
    assert.ok(p.bottleneck!.shareOfTotal > 0.3 && p.bottleneck!.shareOfTotal <= 1);
  });

  it("the total is the per-observation SUM, not the sum of the percentiles", () => {
    // p99 of a sum is not the sum of the p99s; treating it that way badly
    // overstates the tail.
    const p = latencyProfile(samples);
    const sumOfP99 = (["ingest", "persist", "decide", "submit"] as const)
      .reduce((a, s) => a + p.stages[s]!.p99, 0);
    assert.ok(p.total!.p99 < sumOfP99, `${p.total!.p99} should be below ${sumOfP99}`);
    assert.equal(p.total!.n, 5);
  });

  it("a missing stage makes the profile incomplete rather than quietly short", () => {
    const p = latencyProfile({ ...samples, submit: [] });
    assert.equal(p.complete, false);
    assert.equal(p.stages.submit, undefined);
  });

  it("a full profile is complete", () => {
    assert.equal(latencyProfile(samples).complete, true);
  });

  it("no samples at all yields no total and no bottleneck", () => {
    const p = latencyProfile({});
    assert.equal(p.total, null);
    assert.equal(p.bottleneck, null);
    assert.equal(p.complete, false);
  });
});

describe("fill latency selection (M05)", () => {
  const fallback = { minMs: 80, maxMs: 280 };

  it("measured latency WINS over the guess", () => {
    const profile = latencyProfile({
      ingest: [1], persist: [50], decide: [5], submit: [20],
    });
    const l = fillLatency(profile, fallback);
    assert.equal(l.measured, true);
    assert.equal(l.p50, 76, "1 + 50 + 5 + 20");
  });

  it("with no measurement the fallback is used AND marked unmeasured", () => {
    const l = fillLatency(null, fallback);
    assert.equal(l.measured, false, "a run must be able to record that its fills used a guess");
    assert.equal(l.p50, 180);
  });

  it("an incomplete profile with some data still beats the guess", () => {
    const l = fillLatency(latencyProfile({ persist: [500] }), fallback);
    assert.equal(l.measured, true);
    assert.equal(l.p50, 500);
  });

  it("sampling is right-skewed, not uniform", () => {
    // A uniform draw over a range under-samples the slow fills that cost most.
    const l = { p50: 100, p90: 300, p99: 1000, measured: true };
    assert.equal(sampleFillLatencyMs(l, 0), 100);
    assert.equal(sampleFillLatencyMs(l, 0.49), 100);
    assert.equal(sampleFillLatencyMs(l, 0.9), 300);
    assert.equal(sampleFillLatencyMs(l, 1), 1000);
    // The top decile reaches into the tail the fallback range could never express.
    assert.ok(sampleFillLatencyMs(l, 0.95) > 300);
  });

  it("sampling is monotonic and clamped", () => {
    const l = { p50: 100, p90: 300, p99: 1000, measured: true };
    let prev = -1;
    for (let u = 0; u <= 1.0001; u += 0.05) {
      const v = sampleFillLatencyMs(l, u);
      assert.ok(v >= prev, `not monotonic at u=${u}`);
      prev = v;
    }
    assert.equal(sampleFillLatencyMs(l, -5), 100);
    assert.equal(sampleFillLatencyMs(l, 5), 1000);
  });
});
