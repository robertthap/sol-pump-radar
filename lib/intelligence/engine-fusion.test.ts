import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fuseMissTypeCore, pickFusionWinner } from "@/lib/intelligence/engine-fusion-core";

describe("pickFusionWinner", () => {
  it("prefers CONTINUATION_BUY over WATCH when B accelerates", () => {
    const { winner, engine } = pickFusionWinner(
      {
        mint: "a",
        engine: "A",
        state: "launching",
        signal: "WATCH",
        confidence: 0.5,
        rank_percentile: 0.7,
      },
      {
        mint: "a",
        engine: "B",
        state: "acceleration",
        signal: "CONTINUATION_BUY",
        confidence: 0.72,
        rank_percentile: 0.88,
      },
    );
    assert.equal(engine, "B");
    assert.equal(winner.signal, "CONTINUATION_BUY");
  });

  it("prefers BUY_STRONG on early breakout", () => {
    const { winner } = pickFusionWinner(
      {
        mint: "x",
        engine: "A",
        state: "early_breakout",
        signal: "BUY_STRONG",
        confidence: 0.8,
        rank_percentile: 0.85,
      },
      {
        mint: "x",
        engine: "B",
        state: "trend",
        signal: "DEX_TREND_ALERT",
        confidence: 0.75,
        rank_percentile: 0.9,
      },
    );
    assert.equal(winner.signal, "BUY_STRONG");
  });
});

describe("fuseMissTypeCore", () => {
  it("clears miss when actionable signal wins", () => {
    const miss = fuseMissTypeCore(
      {
        mint: "m",
        engine: "B",
        state: "acceleration",
        signal: "CONTINUATION_BUY",
        confidence: 0.7,
        rank_percentile: 0.9,
      },
      null,
      { mint: "m", engine: "B", state: "cold", signal: "NONE", confidence: 0, rank_percentile: 0.2, miss_type: "LOW_RANK" },
    );
    assert.equal(miss, null);
  });
});
