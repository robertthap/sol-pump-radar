import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import { join } from "path";
import { parseSwapFill, type ParsedSwapTx } from "@/lib/executor/swap-fill";
import { effectiveVSolFromPriceSol } from "@/lib/pump/onchain-accounts";

// Real mainnet transactions (jsonParsed, trimmed to the fields the parser reads),
// captured 2026-09-13 from the PumpSwap AMM and pump.fun bonding-curve programs.
type Fixture = { signature: string; mint: string; tx: ParsedSwapTx };
const FIX = JSON.parse(
  readFileSync(join(__dirname, "__fixtures__", "swap-fills.json"), "utf8"),
) as Record<"pumpswap_buy" | "pumpswap_sell" | "curve_buy" | "curve_sell", Fixture>;

const fill = (f: Fixture) => {
  const r = parseSwapFill(f.tx, f.mint);
  assert.ok(r.ok, r.ok ? "" : r.reason);
  return r.fill;
};

describe("parseSwapFill — real transactions", () => {
  it("bonding-curve buy: tokens in, all-in cost includes fee and new token-account rent", () => {
    const f = fill(FIX.curve_buy);
    assert.equal(f.side, "buy");
    assert.equal(f.tokenAccountRentLamports, 1_513_840);
    assert.equal(f.allInLamports, 61_538_840);
    // price excludes network fee and rent, so it sits on the curve's own scale
    const swapSol = (f.allInLamports - f.feeLamports - f.tokenAccountRentLamports) / 1e9;
    assert.ok(Math.abs(f.priceSol - swapSol / (Number(f.tokensRaw) / 1e6)) < 1e-18);
    const vSol = effectiveVSolFromPriceSol(f.priceSol)!;
    assert.ok(vSol > 30 && vSol < 116, `curve-range vSol, got ${vSol}`);
  });

  it("bonding-curve sell that closed the token account: refunded rent is not counted as sale proceeds", () => {
    const f = fill(FIX.curve_sell);
    assert.equal(f.side, "sell");
    assert.equal(f.tokenAccountRentLamports, 1_513_840);
    const swapSol = (f.allInLamports + f.feeLamports - f.tokenAccountRentLamports) / 1e9;
    assert.ok(Math.abs(f.priceSol - swapSol / (Number(f.tokensRaw) / 1e6)) < 1e-18);
  });

  it("PumpSwap buy and sell parse on the same basis", () => {
    const b = fill(FIX.pumpswap_buy);
    const s = fill(FIX.pumpswap_sell);
    assert.equal(b.side, "buy");
    assert.equal(s.side, "sell");
    for (const f of [b, s]) assert.ok(f.priceSol > 1e-10 && f.priceSol < 1e-3, `price ${f.priceSol}`);
  });

  it("a sell whose priority fee exceeds its proceeds still prices the swap, not the net", () => {
    const s = fill(FIX.pumpswap_sell);
    assert.ok(s.feeLamports > s.allInLamports, "fixture: fee 0.001205 SOL > 0.00085 SOL received");
    assert.ok(Math.abs(s.priceSol * (Number(s.tokensRaw) / 1e6) - (s.allInLamports + s.feeLamports) / 1e9) < 1e-12);
  });
});

describe("parseSwapFill — refusals", () => {
  it("a transaction that failed on-chain is not a fill", () => {
    const tx = structuredClone(FIX.curve_buy.tx);
    tx.meta!.err = { InstructionError: [2, { Custom: 6003 }] };
    const r = parseSwapFill(tx, FIX.curve_buy.mint);
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.reason, /failed on-chain/);
  });

  it("a mint the wallet did not trade is not a fill", () => {
    const r = parseSwapFill(FIX.curve_buy.tx, FIX.pumpswap_buy.mint);
    assert.equal(r.ok, false);
  });

  it("a dust sell whose fee exceeds its proceeds is still a fill, with negative all-in SOL", () => {
    const tx = structuredClone(FIX.pumpswap_sell.tx);
    tx.meta!.fee = 3_000_000; // more than the 0.002058 SOL gross proceeds
    tx.meta!.postBalances[0] = tx.meta!.preBalances[0]! + 2_057_675 - 3_000_000;
    const r = parseSwapFill(tx, FIX.pumpswap_sell.mint);
    assert.ok(r.ok);
    assert.ok(r.ok && r.fill.allInLamports < 0);
  });

  it("missing meta is not a fill", () => {
    assert.equal(parseSwapFill({ ...FIX.curve_buy.tx, meta: null }, FIX.curve_buy.mint).ok, false);
  });
});
