import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { pnlFromMcap } from "@/lib/paper/mcap-pnl";

describe("pnlFromMcap", () => {
  it("a 4x in market cap is ~+300% before fees", () => {
    const r = pnlFromMcap({ sizeSol: 1, entryMcapUsd: 30_000, currentMcapUsd: 120_000, pumpFeesPct: 0, paperSlippagePct: 0 });
    assert.ok(Math.abs(r.pctOfSize - 3) < 1e-9, `pct=${r.pctOfSize}`);
    assert.ok(Math.abs(r.pnlSol - 3) < 1e-9);
  });

  it("applies the round-trip friction haircut", () => {
    const r = pnlFromMcap({ sizeSol: 1, entryMcapUsd: 10_000, currentMcapUsd: 10_000, pumpFeesPct: 0.01, paperSlippagePct: 0.02 });
    // friction = (1 - 0.01 - 0.01)^2 = 0.9604 → ~-3.96%
    assert.ok(r.pctOfSize < 0 && r.pctOfSize > -0.05, `pct=${r.pctOfSize}`);
  });

  it("a 50% mcap drop is ~-50%", () => {
    const r = pnlFromMcap({ sizeSol: 2, entryMcapUsd: 100_000, currentMcapUsd: 50_000, pumpFeesPct: 0, paperSlippagePct: 0 });
    assert.ok(Math.abs(r.pctOfSize + 0.5) < 1e-9);
    assert.ok(Math.abs(r.pnlSol + 1) < 1e-9);
  });

  it("returns neutral for invalid/missing mcaps", () => {
    assert.equal(pnlFromMcap({ sizeSol: 1, entryMcapUsd: 0, currentMcapUsd: 100, pumpFeesPct: 0, paperSlippagePct: 0 }).pctOfSize, 0);
    assert.equal(pnlFromMcap({ sizeSol: 1, entryMcapUsd: 100, currentMcapUsd: Number.NaN, pumpFeesPct: 0, paperSlippagePct: 0 }).pctOfSize, 0);
  });
});
