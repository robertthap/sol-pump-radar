import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CommitPipeline } from "@/lib/chart/realtime/commitPipeline";
import type { RawTradeInput } from "@/lib/chart/data/priceResolver";

function raw(id: string, ts: number): RawTradeInput {
  return {
    token: "mint",
    wallet: "w",
    side: "buy",
    amount: 0.1,
    timestamp: ts,
    txHash: `tx-${id}`,
    tradeId: id,
    vSolAfter: 100,
  };
}

describe("commitPipeline", () => {
  it("increments seq by batch size", () => {
    const bundles: unknown[] = [];
    const pipe = new CommitPipeline((b) => bundles.push(b), 999_999);
    pipe.setStreamState("mint", {
      mint: "mint",
      epoch: 1,
      lastTradeId: 0n,
      lastSeq: 10,
      graduationAt: null,
      regime: "bonding_curve",
    });
    pipe.stage("mint", raw("1", 1_000));
    pipe.stage("mint", raw("2", 2_000));
    pipe.stage("mint", raw("3", 3_000));
    pipe.flush("mint");
    assert.equal(bundles.length, 1);
    const b = bundles[0] as { seq: number; lastTradeId: string };
    assert.equal(b.seq, 13);
    assert.equal(b.lastTradeId, "3");
    assert.equal(pipe.getStreamState("mint").lastSeq, 13);
  });

  it("advanceSeq reserves monotonic seq", () => {
    const pipe = new CommitPipeline(() => {}, 999_999);
    pipe.setStreamState("mint", {
      mint: "mint",
      epoch: 1,
      lastTradeId: 5n,
      lastSeq: 4,
      graduationAt: null,
      regime: "bonding_curve",
    });
    const st = pipe.advanceSeq("mint");
    assert.equal(st.lastSeq, 5);
  });
});
