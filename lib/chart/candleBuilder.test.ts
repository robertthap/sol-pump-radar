import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CandleAggregator, replayTrades } from "@/lib/chart/data/candleBuilder";
import type { CommittedTrade } from "@/lib/chart/types";
import { checksumCandles, detectDrift } from "@/lib/chart/engine/reconcile";

function trade(id: string, ts: number, price: number, amount = 1): CommittedTrade {
  return {
    token: "mint",
    wallet: "w",
    side: "buy",
    price,
    amount,
    timestamp: ts,
    txHash: `tx${id}`,
    tradeId: id,
    regime: "bonding_curve",
    marketCap: price * 1e9,
    committedAt: ts,
  };
}

describe("candleBuilder", () => {
  it("aggregates 1000 trades in same bucket without full recompute", () => {
    const agg = new CandleAggregator("1s");
    const base = 1_700_000_000_000;
    for (let i = 0; i < 1000; i++) {
      agg.applyTrade(trade(String(i + 1), base, 0.001 + i * 0.000001, 0.1));
    }
    const candles = agg.getCandlesSorted();
    assert.equal(candles.length, 1);
    assert.ok(Math.abs(candles[0]!.volume - 100) < 1e-6);
    assert.ok(candles[0]!.close > candles[0]!.open);
  });

  it("corrects soft bucket on late trade", () => {
    const agg = new CandleAggregator("1s");
    const base = 1_700_000_000_000;
    agg.applyTrade(trade("1", base, 1, 1));
    agg.applyTrade(trade("2", base + 2000, 2, 1));
    const late = trade("3", base, 1.5, 0.5);
    const patch = agg.applyTrade(late);
    assert.ok(patch);
    assert.equal(patch!.kind, "correction");
    const c = agg.completed.get(base)!;
    assert.ok(c.volume >= 1.5);
    assert.equal(c.close, 1.5);
  });

  it("replayTrades matches incremental for ordered batch", () => {
    const base = 1_700_000_000_000;
    const trades = [
      trade("1", base, 1, 1),
      trade("2", base + 500, 1.2, 1),
      trade("3", base + 1500, 1.5, 1),
    ];
    const inc = new CandleAggregator("1s");
    inc.applyBatch(trades);
    const rep = replayTrades("1s", trades);
    assert.equal(
      checksumCandles(inc.getCandlesSorted()),
      checksumCandles(rep.getCandlesSorted()),
    );
  });

  it("detectDrift flags mismatched tails", () => {
    const a = [{ time: 1, open: 1, high: 1, low: 1, close: 1, volume: 1, state: "final" as const }];
    const b = [{ time: 1, open: 1, high: 1, low: 1, close: 2, volume: 1, state: "final" as const }];
    assert.equal(detectDrift(a, b), true);
  });
});
