import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyCommitBundle,
  applySyncSnapshot,
  createInitialSlice,
  flushLiveBuffer,
  mergeCandlePatches,
  setLiveEdge,
  visibleCandles,
} from "@/components/chart/chartStore";
import type { CandlePatch, CommitBundle } from "@/lib/chart/types";

function bundle(patches: CandlePatch[], seq: number): CommitBundle {
  return {
    mint: "m",
    epoch: 1,
    seq,
    lastTradeId: String(seq),
    trades: [],
    candlePatches: patches,
    marketCap: 1000,
    regime: "bonding_curve",
  };
}

describe("chartStore", () => {
  it("buffers bundles off live edge and flushes on return", () => {
    let s = createInitialSlice("m", "1m");
    s = {
      ...s,
      historicalCandles: [{ time: 1, open: 1, high: 1, low: 1, close: 1, volume: 0, state: "final" }],
      isAtLiveEdge: false,
    };
    const patch: CandlePatch = {
      tf: "1m",
      bucketTime: 60_000,
      kind: "update",
      candle: { time: 2, open: 2, high: 2, low: 2, close: 2, volume: 0, state: "open" },
    };
    s = applyCommitBundle(s, bundle([patch], 1));
    assert.equal(s.liveBuffer.length, 1);
    assert.equal(visibleCandles(s).length, 2);
    s = setLiveEdge(s, true);
    assert.equal(s.liveBuffer.length, 0);
    assert.equal(s.historicalCandles.length, 2);
  });

  it("mergeCandlePatches replaces bucket by time", () => {
    const candles = [{ time: 1, open: 1, high: 1, low: 1, close: 1, volume: 1, state: "final" as const }];
    const out = mergeCandlePatches(
      candles,
      [
        {
          tf: "1m",
          bucketTime: 60_000,
          kind: "correction",
          candle: { time: 1, open: 1, high: 2, low: 1, close: 1.5, volume: 2, state: "soft" },
        },
      ],
      "1m",
    );
    assert.equal(out[0]!.close, 1.5);
    assert.equal(out[0]!.volume, 2);
  });

  it("applySyncSnapshot merges tail without dropping scroll-back", () => {
    let s = createInitialSlice("m", "1m");
    s = {
      ...s,
      historicalCandles: [
        { time: 1, open: 1, high: 1, low: 1, close: 1, volume: 0, state: "final" },
        { time: 2, open: 2, high: 2, low: 2, close: 2, volume: 0, state: "final" },
      ],
    };
    s = applySyncSnapshot(s, {
      mint: "m",
      tf: "1m",
      epoch: 1,
      lastTradeId: "5",
      candles: [{ time: 2, open: 2, high: 2.5, low: 2, close: 2.4, volume: 1, state: "open" }],
      marketCap: 2400,
      regime: "bonding_curve",
      graduationAt: null,
    });
    assert.equal(s.historicalCandles.length, 2);
    assert.equal(s.historicalCandles[1]!.close, 2.4);
    assert.equal(s.marketCap, 2400);
  });

  it("applySyncSnapshot DROPS a stale snapshot (same epoch, behind lastTradeId) — T2.1", () => {
    let s = createInitialSlice("m", "1m");
    // client already advanced to lastTradeId 150 via live bundles
    s = { ...s, lastTradeId: "150", chartSeq: { epoch: 1, seq: 9 }, marketCap: 9999 };
    const before = s;
    s = applySyncSnapshot(s, {
      mint: "m", tf: "1m", epoch: 1, lastTradeId: "100", // BEHIND
      candles: [{ time: 1, open: 1, high: 1, low: 1, close: 1, volume: 0, state: "final" }],
      marketCap: 1111, regime: "bonding_curve", graduationAt: null,
    });
    // unchanged — stale snapshot dropped, the "fix" sticks
    assert.equal(s, before);
    assert.equal(s.lastTradeId, "150");
    assert.equal(s.marketCap, 9999);
  });

  it("applySyncSnapshot ACCEPTS a snapshot at/ahead of current lastTradeId — T2.1", () => {
    let s = createInitialSlice("m", "1m");
    s = { ...s, lastTradeId: "100", chartSeq: { epoch: 1, seq: 5 } };
    s = applySyncSnapshot(s, {
      mint: "m", tf: "1m", epoch: 1, lastTradeId: "200", // AHEAD
      candles: [{ time: 1, open: 1, high: 1, low: 1, close: 1.5, volume: 0, state: "open" }],
      marketCap: 2000, regime: "bonding_curve", graduationAt: null,
    });
    assert.equal(s.lastTradeId, "200");
    assert.equal(s.marketCap, 2000);
  });

  it("applySyncSnapshot ACCEPTS a newer epoch even if lastTradeId resets (worker restart) — T2.1", () => {
    let s = createInitialSlice("m", "1m");
    s = { ...s, lastTradeId: "150", chartSeq: { epoch: 1, seq: 9 } };
    s = applySyncSnapshot(s, {
      mint: "m", tf: "1m", epoch: 2, lastTradeId: "3", // epoch bumped, ids reset
      candles: [{ time: 1, open: 1, high: 1, low: 1, close: 1, volume: 0, state: "final" }],
      marketCap: 500, regime: "bonding_curve", graduationAt: null,
    });
    assert.equal(s.chartSeq.epoch, 2);
    assert.equal(s.lastTradeId, "3");
  });

  it("applySyncSnapshot DROPS an older epoch — T2.1", () => {
    let s = createInitialSlice("m", "1m");
    s = { ...s, lastTradeId: "5", chartSeq: { epoch: 2, seq: 1 }, marketCap: 7777 };
    const before = s;
    s = applySyncSnapshot(s, {
      mint: "m", tf: "1m", epoch: 1, lastTradeId: "999", // older epoch wins on lastTradeId but loses on epoch
      candles: [], marketCap: 1, regime: "bonding_curve", graduationAt: null,
    });
    assert.equal(s, before);
    assert.equal(s.marketCap, 7777);
  });

  it("flushLiveBuffer applies seq from last bundle", () => {
    let s = createInitialSlice("m", "1m");
    s = {
      ...s,
      isAtLiveEdge: false,
      liveBuffer: [bundle([], 3), bundle([], 7)],
    };
    s = flushLiveBuffer(s);
    assert.equal(s.chartSeq.seq, 7);
  });
});
