import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  scoreLaunchHot,
  type LaunchActivity,
  type LaunchGateConfig,
} from "@/lib/intelligence/launch-hot-gate";

const DEFAULT_CFG: LaunchGateConfig = {
  minVSol: 2,
  minTrades: 1,
  minUniqueWallets: 2,
  minGates: 2,
  minHotScore: 0.45,
};

function act(partial: Partial<LaunchActivity>): LaunchActivity {
  return {
    mint: "mint1",
    creatorWallet: "creator",
    tradeCount: 0,
    uniqueWallets: 1,
    maxVSol: 0,
    ...partial,
  };
}

describe("scoreLaunchHot", () => {
  it("rejects create-only noise (no trades, no liq)", () => {
    const r = scoreLaunchHot(act({}), DEFAULT_CFG);
    assert.equal(r.qualified, false);
  });

  it("qualifies with liquidity + trades + wallet diversity", () => {
    const r = scoreLaunchHot(
      act({
        maxVSol: 3,
        tradeCount: 2,
        uniqueWallets: 3,
      }),
      DEFAULT_CFG,
    );
    assert.equal(r.qualified, true);
    assert.ok(r.hotScore >= 0.45);
  });
});
