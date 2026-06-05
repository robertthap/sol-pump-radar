import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { analyzeCopyTradeSafety, type WalletProfileInput } from "@/lib/wallet/copy-trade-safety";

const base: WalletProfileInput = {
  wallet: "W",
  tradeCount: 30,
  distinctMints: 20,
  closedMints: 20,
  avgReturn: 0.25,
  tStat: 2.3,
  last5Return: 0.2,
  last10Return: 0.15,
  isBumpBot: false,
  sniperRate: 0.1,
  bundleRate: 0.05,
  clusterKind: null,
  clusterMembers: null,
  lastSeen: null,
};

describe("analyzeCopyTradeSafety", () => {
  it("unknown when no history", () => {
    assert.equal(analyzeCopyTradeSafety(null).verdict, "unknown");
    assert.equal(analyzeCopyTradeSafety({ ...base, closedMints: 0 }).verdict, "unknown");
  });

  it("safe for a proven, organic, large-sample edge", () => {
    const a = analyzeCopyTradeSafety(base);
    assert.equal(a.verdict, "safe");
    assert.ok(a.score >= 75, `score=${a.score}`);
    assert.ok(a.positives.length > 0);
  });

  it("avoid for a bump bot regardless of returns", () => {
    const a = analyzeCopyTradeSafety({ ...base, isBumpBot: true });
    assert.equal(a.verdict, "avoid");
    assert.ok(a.score <= 10);
  });

  it("avoid for bundle-ring members", () => {
    const a = analyzeCopyTradeSafety({ ...base, clusterKind: "bundle_ring", clusterMembers: 5 });
    assert.equal(a.verdict, "avoid");
  });

  it("caution for a weak/unproven positive edge", () => {
    const a = analyzeCopyTradeSafety({ ...base, tStat: 1.2, closedMints: 6, avgReturn: 0.08 });
    assert.equal(a.verdict, "caution");
  });

  it("unknown for too few closed trades", () => {
    assert.equal(analyzeCopyTradeSafety({ ...base, closedMints: 2 }).verdict, "unknown");
  });

  it("avoid when no statistical edge", () => {
    const a = analyzeCopyTradeSafety({ ...base, tStat: 0.4, avgReturn: -0.05, last5Return: -0.1 });
    assert.equal(a.verdict, "avoid");
  });
});
