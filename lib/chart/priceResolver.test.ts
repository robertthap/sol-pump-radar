import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  bondingCurveUnitPrice,
  nearestDexQuote,
  regimeForTrade,
  resolveUnitPrice,
} from "@/lib/chart/data/priceResolver";
import type { DexQuoteRow } from "@/lib/chart/types";

describe("priceResolver", () => {
  it("uses bonding curve before graduation", () => {
    const stream = { graduationAt: new Date(2_000), regime: "bonding_curve" as const };
    assert.equal(regimeForTrade(stream, 1_000), "bonding_curve");
    assert.equal(regimeForTrade(stream, 3_000), "dex");
  });

  it("picks nearest dex quote before trade time", () => {
    const quotes: DexQuoteRow[] = [
      { mint: "m", ts: new Date(1_000), priceUsd: 0.00001, mcapUsd: 10_000, source: "dex" },
      { mint: "m", ts: new Date(5_000), priceUsd: 0.00002, mcapUsd: 20_000, source: "dex" },
    ];
    const q = nearestDexQuote(quotes, 4_000);
    assert.equal(q?.priceUsd, 0.00001);
  });

  it("resolveUnitPrice uses dex quote after graduation", () => {
    const stream = { graduationAt: new Date(0), regime: "dex" as const };
    const quotes: DexQuoteRow[] = [
      { mint: "m", ts: new Date(1_000), priceUsd: 0.00003, mcapUsd: 30_000, source: "dex" },
    ];
    const { price, regime } = resolveUnitPrice(
      {
        token: "m",
        wallet: "w",
        side: "buy",
        amount: 1,
        timestamp: 2_000,
        txHash: "tx",
        tradeId: "1",
        vSolAfter: 50,
      },
      stream,
      quotes,
    );
    assert.equal(regime, "dex");
    assert.equal(price, 0.00003);
  });

  it("bondingCurveUnitPrice is positive for valid vSol", () => {
    assert.ok(bondingCurveUnitPrice(120) > 0);
  });
});
