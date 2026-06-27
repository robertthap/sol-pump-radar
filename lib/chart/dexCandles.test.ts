import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mergeGraduatedCandles, quotesToCandles, stitchCurveAndDex } from "@/lib/chart/data/dexCandles";
import type { Candle, DexQuoteRow } from "@/lib/chart/types";

describe("dexCandles", () => {
  it("builds OHLC from quote ticks in 1m buckets", () => {
    const quotes: DexQuoteRow[] = [
      { mint: "m", ts: new Date(60_000), priceUsd: 0.00001, mcapUsd: 10_000, source: "dex" },
      { mint: "m", ts: new Date(90_000), priceUsd: 0.00002, mcapUsd: 20_000, source: "dex" },
      { mint: "m", ts: new Date(120_000), priceUsd: 0.000015, mcapUsd: 15_000, source: "dex" },
    ];
    const candles = quotesToCandles("1m", quotes, { afterMs: 0 });
    assert.equal(candles.length, 2);
    assert.equal(candles[0]!.open, 0.00001);
    assert.equal(candles[0]!.close, 0.00002);
    assert.equal(candles[0]!.high, 0.00002);
    // Subsequent candles' opens are chained to the previous candle's close so
    // snapshot-based DEX data produces real directional bodies (see dexCandles.ts).
    assert.equal(candles[1]!.open, 0.00002);
    assert.equal(candles[1]!.close, 0.000015);
  });

  it("stitches first DEX open to last curve close", () => {
    const curve: Candle[] = [
      { time: 100, open: 1, high: 1.2, low: 0.9, close: 1.1, volume: 5, state: "final" },
    ];
    const dex: Candle[] = [
      { time: 120, open: 2, high: 2.1, low: 1.9, close: 2, volume: 0, state: "open" },
    ];
    const merged = stitchCurveAndDex(curve, dex, 120_000, "1m");
    assert.equal(merged.length, 2);
    assert.equal(merged[1]!.open, 1.1);
    assert.equal(merged[1]!.close, 2);
  });

  it("mergeGraduatedCandles drops overlapping curve tail after graduation bucket", () => {
    const curve: Candle[] = [
      { time: 100, open: 1, high: 1, low: 1, close: 1, volume: 1, state: "final" },
      { time: 120, open: 1, high: 1, low: 1, close: 1, volume: 1, state: "final" },
    ];
    const quotes: DexQuoteRow[] = [
      { mint: "m", ts: new Date(120_000), priceUsd: 2, mcapUsd: 2e9, source: "dex" },
      { mint: "m", ts: new Date(180_000), priceUsd: 2.5, mcapUsd: 2.5e9, source: "dex" },
    ];
    const merged = mergeGraduatedCandles("1m", curve, quotes, 120_000);
    assert.ok(merged.some((c) => c.time === 120 && c.close === 2));
    assert.equal(merged.filter((c) => c.time === 120).length, 1);
  });
});
