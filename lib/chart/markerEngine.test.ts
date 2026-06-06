import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildMarkers,
  findMarkerAtCrosshair,
  markerId,
} from "@/lib/chart/engine/markerEngine";
import type { UserTrade } from "@/lib/chart/types";

describe("markerEngine", () => {
  it("uses stable marker ids", () => {
    assert.equal(markerId("pos1", "42", "buy"), "pos1:42:buy");
    assert.equal(markerId("pos1", "42", "sell"), "pos1:42:sell");
  });

  it("attaches realized pnl to sell markers", () => {
    const fills: UserTrade[] = [
      {
        wallet: "w",
        token: "mint",
        side: "buy",
        price: 0.00001,
        amount: 0.5,
        timestamp: 1_700_000_000_000,
        txHash: "tx1",
        positionId: "p1",
        tradeId: "1",
      },
      {
        wallet: "w",
        token: "mint",
        side: "sell",
        price: 0.00002,
        amount: 0.5,
        timestamp: 1_700_000_060_000,
        txHash: "tx2",
        positionId: "p1",
        tradeId: "2",
      },
    ];
    const markers = buildMarkers(fills, "1m");
    const sell = [...markers.values()].find((m) => m.side === "sell");
    assert.ok(sell);
    assert.ok(sell!.pnl != null && sell!.pnl > 0);
  });

  it("finds marker at crosshair bucket", () => {
    const fills: UserTrade[] = [
      {
        wallet: "w",
        token: "mint",
        side: "buy",
        price: 0.00001,
        amount: 0.5,
        timestamp: 1_700_000_005_000,
        txHash: "tx1",
        positionId: "p1",
        tradeId: "1",
      },
    ];
    const markers = buildMarkers(fills, "1m");
    const m = findMarkerAtCrosshair(markers, Math.floor(1_700_000_005_000 / 1000), "1m");
    assert.ok(m);
    assert.equal(m!.side, "buy");
  });
});
