import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mcapUsdFromVSol, effectiveVSolFromMcapUsd, CURVE_DIV, SOL_USD } from "@/lib/dex/curve-mcap";

describe("curve-mcap", () => {
  it("mcapUsdFromVSol matches the curve formula", () => {
    // vSol 30 (fresh launch) → ~$4.2k at $150 SOL
    const m = mcapUsdFromVSol(30)!;
    assert.ok(Math.abs(m - (900 / CURVE_DIV) * SOL_USD) < 1e-6);
    assert.ok(m > 4000 && m < 4500);
  });

  it("returns null for non-positive / non-finite vSol", () => {
    assert.equal(mcapUsdFromVSol(0), null);
    assert.equal(mcapUsdFromVSol(-5), null);
    assert.equal(mcapUsdFromVSol(Number.NaN), null);
  });

  it("effectiveVSolFromMcapUsd is the inverse of mcapUsdFromVSol", () => {
    for (const vSol of [30, 46.9, 85.3, 115]) {
      const mcap = mcapUsdFromVSol(vSol)!;
      const back = effectiveVSolFromMcapUsd(mcap)!;
      assert.ok(Math.abs(back - vSol) < 1e-6, `${vSol} -> ${mcap} -> ${back}`);
    }
  });

  it("maps a graduated DEX mcap to a large effective vSol (price discovery)", () => {
    // H74CYm real case: entry vSol ~85 (~$33k), DEX mcap $3.5M after graduation.
    const eff = effectiveVSolFromMcapUsd(3_498_600)!;
    // (eff/85)^2 should reflect the ~100x move the bonding-curve vSol froze out.
    const ratioSq = (eff / 85) ** 2;
    assert.ok(ratioSq > 50 && ratioSq < 200, `ratioSq=${ratioSq}`);
  });

  it("returns null for missing/invalid mcap", () => {
    assert.equal(effectiveVSolFromMcapUsd(null), null);
    assert.equal(effectiveVSolFromMcapUsd(0), null);
    assert.equal(effectiveVSolFromMcapUsd(undefined), null);
  });
});
