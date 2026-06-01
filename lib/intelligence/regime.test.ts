import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyRegime,
  regimeAdjustedConfig,
  regimeStatsFrom,
} from "@/lib/intelligence/regime";
import { defaultGateConfig } from "@/lib/intelligence/gate-config";

describe("classifyRegime", () => {
  it("flags high_rug when rug fraction is high and tightens hard", () => {
    const r = classifyRegime({ universeSize: 40, rugFraction: 0.6, freshFraction: 0.3, positiveMomFraction: 0.4 });
    assert.equal(r.regime, "high_rug");
    assert.ok(r.riskMultiplier > 1);
  });

  it("flags low_liquidity when universe is tiny", () => {
    const r = classifyRegime({ universeSize: 4, rugFraction: 0.1, freshFraction: 0.0, positiveMomFraction: 0.1 });
    assert.equal(r.regime, "low_liquidity");
    assert.ok(r.riskMultiplier > 1);
  });

  it("flags risk_on with broad momentum + fresh flow + low rug", () => {
    const r = classifyRegime({ universeSize: 50, rugFraction: 0.1, freshFraction: 0.4, positiveMomFraction: 0.6 });
    assert.equal(r.regime, "risk_on");
    assert.ok(r.riskMultiplier < 1);
  });

  it("defaults to neutral", () => {
    const r = classifyRegime({ universeSize: 30, rugFraction: 0.2, freshFraction: 0.2, positiveMomFraction: 0.35 });
    assert.equal(r.regime, "neutral");
    assert.equal(r.riskMultiplier, 1);
  });
});

describe("regimeAdjustedConfig", () => {
  it("raises velocity/rank floors in high_rug (stricter)", () => {
    const base = defaultGateConfig("hybrid");
    const adj = regimeAdjustedConfig(base, classifyRegime({ universeSize: 40, rugFraction: 0.7, freshFraction: 0.3, positiveMomFraction: 0.3 }));
    assert.ok(adj.engineA.velocityFloor > base.engineA.velocityFloor);
    assert.ok(adj.engineA.rankFloor > base.engineA.rankFloor);
    assert.ok(adj.engineA.liqFloorUsd > base.engineA.liqFloorUsd);
  });

  it("loosens floors in risk_on", () => {
    const base = defaultGateConfig("hybrid");
    const adj = regimeAdjustedConfig(base, classifyRegime({ universeSize: 50, rugFraction: 0.1, freshFraction: 0.4, positiveMomFraction: 0.7 }));
    assert.ok(adj.engineA.velocityFloor < base.engineA.velocityFloor);
  });

  it("neutral leaves the config unchanged", () => {
    const base = defaultGateConfig("hybrid");
    const adj = regimeAdjustedConfig(base, classifyRegime({ universeSize: 30, rugFraction: 0.2, freshFraction: 0.2, positiveMomFraction: 0.35 }));
    assert.equal(adj.engineA.velocityFloor, base.engineA.velocityFloor);
  });
});

describe("regimeStatsFrom", () => {
  it("computes fractions from snapshots", () => {
    const s = regimeStatsFrom([
      { ageSeconds: 30, isNewPool: true, priceChangeM5: 5, rug: false },
      { ageSeconds: 1000, isNewPool: false, priceChangeM5: -2, rug: true },
      { ageSeconds: 100, isNewPool: false, priceChangeM5: 8, rug: false },
      { ageSeconds: 5000, isNewPool: false, priceChangeM5: -1, rug: false },
    ]);
    assert.equal(s.universeSize, 4);
    assert.equal(s.rugFraction, 0.25);
    assert.equal(s.freshFraction, 0.5); // 30s + 100s are <300s
    assert.equal(s.positiveMomFraction, 0.5);
  });

  it("is safe on an empty universe", () => {
    const s = regimeStatsFrom([]);
    assert.equal(s.universeSize, 0);
    assert.equal(s.rugFraction, 0);
  });
});
