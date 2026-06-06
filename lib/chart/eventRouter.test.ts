import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shouldAcceptSeq, hasGap } from "@/lib/chart/realtime/eventRouter";

describe("eventRouter", () => {
  it("rejects stale seq on same epoch", () => {
    assert.equal(
      shouldAcceptSeq({ epoch: 1, seq: 5, lastTradeId: "10" }, { epoch: 1, seq: 4, lastTradeId: "11" }),
      false,
    );
  });

  it("accepts higher epoch", () => {
    assert.equal(
      shouldAcceptSeq({ epoch: 1, seq: 99, lastTradeId: "10" }, { epoch: 2, seq: 1, lastTradeId: "1" }),
      true,
    );
  });

  it("detects trade id gap", () => {
    assert.equal(hasGap("5", "7"), true);
    assert.equal(hasGap("5", "6"), false);
    assert.equal(hasGap("5", "8", "6"), false);
    assert.equal(hasGap("5", "8", "7"), true);
  });
});
