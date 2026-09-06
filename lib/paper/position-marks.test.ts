import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ageSeconds, shouldMark, MARK_INTERVAL_MS } from "@/lib/paper/position-marks";

describe("shouldMark - sampling cadence", () => {
  const now = 1_000_000;

  it("a never-marked position is always due, so every position gets a t=0 sample", () => {
    assert.equal(shouldMark(null, now), true);
    assert.equal(shouldMark(undefined, now), true);
  });

  it("not due before the interval, due at and after it", () => {
    assert.equal(shouldMark(now - (MARK_INTERVAL_MS - 1), now), false);
    assert.equal(shouldMark(now - MARK_INTERVAL_MS, now), true);
    assert.equal(shouldMark(now - MARK_INTERVAL_MS * 3, now), true);
  });

  it("a 3s tick loop produces one mark per interval, not one per tick", () => {
    let last: number | null = null;
    let marks = 0;
    for (let t = 0; t <= 300_000; t += 3_000) {
      if (shouldMark(last, t)) {
        marks += 1;
        last = t;
      }
    }
    // 5 minutes at 30s = 11 marks (t=0 plus one every 30s), not 101 ticks.
    assert.equal(marks, 11);
  });

  it("a non-finite timestamp is treated as never marked rather than skipping forever", () => {
    assert.equal(shouldMark(Number.NaN, now), true);
  });

  it("honours a custom interval", () => {
    assert.equal(shouldMark(now - 5_000, now, 10_000), false);
    assert.equal(shouldMark(now - 10_000, now, 10_000), true);
  });
});

describe("ageSeconds", () => {
  const now = Date.parse("2026-09-06T12:00:00Z");

  it("returns whole seconds since the timestamp", () => {
    assert.equal(ageSeconds("2026-09-06T11:59:00Z", now), 60);
  });

  it("null for missing or unparseable input", () => {
    assert.equal(ageSeconds(null, now), null);
    assert.equal(ageSeconds(undefined, now), null);
    assert.equal(ageSeconds("not a date", now), null);
  });

  it("never negative when the source clock is ahead", () => {
    assert.equal(ageSeconds("2026-09-06T12:00:30Z", now), 0);
  });
});
