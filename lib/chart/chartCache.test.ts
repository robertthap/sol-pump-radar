import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mergeSnapshotTail } from "@/lib/chart/data/chartCache";
import type { Candle } from "@/lib/chart/types";

function candle(time: number, close: number): Candle {
  return { time, open: close, high: close, low: close, close, volume: 1, state: "final" };
}

describe("chartCache", () => {
  it("mergeSnapshotTail keeps older REST history and refreshes tail", () => {
    const existing = [candle(100, 1), candle(160, 2), candle(220, 3)];
    const snap = [candle(160, 2.5), candle(220, 3.5), candle(280, 4)];
    const merged = mergeSnapshotTail(existing, snap);
    assert.equal(merged.length, 4);
    assert.equal(merged[0]!.time, 100);
    assert.equal(merged[1]!.close, 2.5);
    assert.equal(merged[3]!.close, 4);
  });

  it("mergeSnapshotTail returns snap when existing is empty", () => {
    const snap = [candle(100, 1)];
    assert.deepEqual(mergeSnapshotTail([], snap), snap);
  });
});
