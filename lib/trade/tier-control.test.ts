import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  shouldEnableRelaxedTier,
  setRelaxedTierEnabled,
  relaxedTierEnabled,
} from "@/lib/trade/tier-control";

const strictGood = { trades: 40, winRate: 0.55, expectancySol: 0.01 };

describe("shouldEnableRelaxedTier", () => {
  it("keeps relaxed on when samples are insufficient", () => {
    const r = shouldEnableRelaxedTier(strictGood, { trades: 10, winRate: 0.2, expectancySol: -0.05 });
    assert.equal(r.enabled, true);
  });

  it("disables relaxed when its expectancy is negative with enough samples", () => {
    const r = shouldEnableRelaxedTier(strictGood, { trades: 40, winRate: 0.3, expectancySol: -0.004 });
    assert.equal(r.enabled, false);
  });

  it("disables relaxed when it badly trails strict win rate", () => {
    const r = shouldEnableRelaxedTier(strictGood, { trades: 40, winRate: 0.45, expectancySol: 0.001 });
    assert.equal(r.enabled, false);
  });

  it("keeps relaxed on when it is healthy", () => {
    const r = shouldEnableRelaxedTier(strictGood, { trades: 40, winRate: 0.53, expectancySol: 0.008 });
    assert.equal(r.enabled, true);
  });
});

describe("relaxedTier flag", () => {
  it("round-trips the process-local flag", () => {
    setRelaxedTierEnabled(false);
    assert.equal(relaxedTierEnabled(), false);
    setRelaxedTierEnabled(true);
    assert.equal(relaxedTierEnabled(), true);
  });
});
