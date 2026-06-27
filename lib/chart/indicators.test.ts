import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sma, ema, rsi } from "@/lib/chart/engine/indicators";
import type { Candle } from "@/lib/chart/types";

function bar(t: number, c: number): Candle {
  return { time: t, open: c, high: c, low: c, close: c, volume: 1, state: "final" };
}

describe("indicators", () => {
  it("sma returns expected length", () => {
    const candles = [1, 2, 3, 4, 5].map((c, i) => bar(i + 1, c));
    const lines = sma(candles, 3);
    assert.equal(lines.length, 3);
    assert.equal(lines[0]!.value, 2);
  });

  it("rsi stays in 0-100", () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 20; i++) {
      candles.push(bar(i + 1, 1 + (i % 3) * 0.01));
    }
    const lines = rsi(candles, 14);
    assert.ok(lines.length > 0);
    for (const p of lines) {
      assert.ok(p.value >= 0 && p.value <= 100);
    }
  });

  it("ema matches first close at start", () => {
    const candles = [bar(1, 10), bar(2, 12)];
    const lines = ema(candles, 5);
    assert.equal(lines[0]!.value, 10);
  });
});
