import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { useChartStore } from "@/components/chart/chartStore";

describe("chartStore per-mint slices", () => {
  it("keeps independent state per mint", () => {
    useChartStore.getState().resetMint("mint-a");
    useChartStore.getState().resetMint("mint-b");
    useChartStore.getState().setHistorical("mint-a", [{ time: 1, open: 1, high: 1, low: 1, close: 1, volume: 1, state: "final" }], null);
    useChartStore.getState().setHistorical("mint-b", [{ time: 2, open: 2, high: 2, low: 2, close: 2, volume: 1, state: "final" }], null);

    const a = useChartStore.getState().slices["mint-a"]!;
    const b = useChartStore.getState().slices["mint-b"]!;
    assert.equal(a.historicalCandles[0]!.close, 1);
    assert.equal(b.historicalCandles[0]!.close, 2);
  });
});
