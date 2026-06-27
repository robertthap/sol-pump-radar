import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MultiTfAggregator } from "@/lib/chart/data/candleBuilder";
import type { CommittedTrade } from "@/lib/chart/types";

function trade(id: number, ts: number, price: number): CommittedTrade {
  return {
    token: "mint",
    wallet: "w",
    side: "buy",
    price,
    amount: 0.01,
    timestamp: ts,
    txHash: `tx${id}`,
    tradeId: String(id),
    regime: "bonding_curve",
    marketCap: price * 1e9,
    committedAt: ts,
  };
}

describe("chart load smoke", () => {
  it("applies 10k trades across 1m buckets under 1500ms", () => {
    const agg = new MultiTfAggregator();
    const base = 1_700_000_000_000;
    const started = performance.now();
    const batch: CommittedTrade[] = [];
    for (let i = 0; i < 10_000; i++) {
      batch.push(trade(i + 1, base + i * 60_000, 0.001 + i * 1e-9));
    }
    agg.applyBatch(batch);
    const elapsed = performance.now() - started;
    // Generous ceiling for laptop-class hardware under contention; still
    // catches catastrophic regressions without flaking on a busy machine.
    assert.ok(elapsed < 1500, `elapsed ${elapsed}ms`);
    assert.ok(agg.aggs["1m"].getCandlesSorted().length >= 10_000);
  });
});
