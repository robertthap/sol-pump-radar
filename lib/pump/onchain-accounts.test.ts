import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  bondingCurveAddress,
  canonicalPumpSwapPoolAddress,
  curveEffectiveVSol,
  decodeBondingCurve,
  decodePool,
  decodePoolVaults,
  isSolQuotedCurve,
  decodeTokenAccountAmount,
  effectiveVSolFromPriceSol,
  poolPriceSol,
} from "@/lib/pump/onchain-accounts";

// Real mainnet account bytes captured 2026-09-13 (first 81 / 211 bytes).
const FIXTURES = {
  graduatedCurve:
    "F7f4N2DYrGAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAxqR+jQMAAVQv2z4WpYnDeapVOtt1KsXcYIdGqEIUwWusC1P/94gV",
  graduatedPool:
    "8ZptBBGxbbz9AAB4wcO5pypsKxkhxPT8mORYVZUOu8FgUQugeDWydYkvlI64sAfvxRV2W7LgnuqvVyABOFwtIY+f1jp8DXkyYN1PBpuIV/6rgYT7aH9jRhjANdrEOdwa6ztVmKDwAAAAAAFZRbNa3n2E0JRxqSa3yAyAv9jYF8XDh68s/elh/LXgQW/0Fg/PwLW9nL09c6PKYXtdYPjxWbGDJ1/kxbs87AUGJzcMt+5vgVRJwhPHjYx/kWMJ7D6eviNJC8MLR7lmSqLge2tZ0AMAAA==",
  curveCurve:
    "F7f4N2DYrGAAENhH488DAEasI/wGAAAAAHjF+1HRAgBGAAAAAAAAAACAxqR+jQMAABzOgBgKRI7zXOLShLDcigo+Y4q9uMdkewTKCwPiRxi4",
};
const GRADUATED_MINT = "Ac8EScJ4ufRo8PiFkun7diUrcCCktg4JvArb3mPmpump";
// A newer PumpSwap pool (full 301-byte account) that prices with a virtual SOL reserve.
const VIRTUAL_POOL_MINT = "6sjYXshPsoGNvxBHXvMBTga1McYJRptNCq6hGWB3pump";
const VIRTUAL_POOL_B64 =
  "8ZptBBGxbbz/AADsOGNtrYp47V8ySkbJ5nmCLLUGN7eLGT587f4wee3gu1dJlFCqRhvimiT2eumdbENO5NjazB9NiMy4Eg9ohVnvBpuIV/6rgYT7aH9jRhjANdrEOdwa6ztVmKDwAAAAAAEBYrDQDViyyM/rHQiSiXeVAFwKVueteWv0kXaJ4vcTaKykHtzj+RTsoTTcspXFjQxWLIhbWmI4HTXfzYYF63c9q+WEyZZxZ3gkcm8fkJBe2l0a6gy3KEbkgr45ZhMBCAVPQ2tZ0AMAAER2T9mw6L6AZxo6FjgoeojXLI68lAAra/9qynbSTXorAADJQR4YBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";
const buf = (b64: string) => Buffer.from(b64, "base64");

describe("addresses", () => {
  it("derives the canonical PumpSwap pool pump.fun migrates into (matches pool_registry)", () => {
    // Pairs from pool_registry (dex_id = pumpswap).
    assert.equal(canonicalPumpSwapPoolAddress(GRADUATED_MINT), "DyHVcioYGVZRVvT7wsoWmYi3UhrXnyZwzrA6C55ptJB7");
    assert.equal(
      canonicalPumpSwapPoolAddress("5s7tf6ih2CEZf7ZPNkJAtcknAq9DL5GsWHMMT3Jdpump"),
      "EyUhvULaCx9N1a3mj4LZTs6ju7Ejk49sFmtjNe65MPNv",
    );
  });

  it("bonding-curve and pool addresses are deterministic and distinct", () => {
    const a = bondingCurveAddress(GRADUATED_MINT);
    assert.equal(a, bondingCurveAddress(GRADUATED_MINT));
    assert.notEqual(a, canonicalPumpSwapPoolAddress(GRADUATED_MINT));
  });
});

describe("decodeBondingCurve (real accounts)", () => {
  it("a graduated coin's curve reads complete with emptied reserves", () => {
    const s = decodeBondingCurve(buf(FIXTURES.graduatedCurve));
    assert.deepEqual(s, { virtualTokenReserves: 0, virtualSolReserves: 0, realSolReserves: 0, complete: true });
  });

  it("isSolQuotedCurve: real SOL-quoted curves hold their real reserve as lamports (measured values)", () => {
    // lamports = real reserve + rent (1,417,320 lamports for 151 bytes)
    assert.equal(isSolQuotedCurve(28_803_123_000 + 1_417_320, 28.803123), true); // standard, mid-curve
    assert.equal(isSolQuotedCurve(1_453_000 + 1_417_320, 0.001453), true); // standard, fresh
    assert.equal(isSolQuotedCurve(104_260_000 + 1_417_320, 0.10426), true); // Mayhem, SOL-quoted
  });

  it("isSolQuotedCurve: curves quoted in another asset hold only rent (measured values)", () => {
    assert.equal(isSolQuotedCurve(1_417_320 - 524_520, 19.578578), false);
    assert.equal(isSolQuotedCurve(1_417_320 - 524_520, 0.046633), false);
    assert.equal(isSolQuotedCurve(1_417_320 - 524_520, 1.890435), false);
  });

  it("a curve coin reads its virtual reserves on the events.v_sol_after basis", () => {
    const s = decodeBondingCurve(buf(FIXTURES.curveCurve))!;
    assert.equal(s.complete, false);
    assert.ok(Math.abs(s.virtualSolReserves - 30.00000007) < 1e-9);
    assert.ok(Math.abs(s.virtualTokenReserves - 1_073_000_000) < 1e-3);
  });

  it("curveEffectiveVSol equals the raw reserve on the standard curve", () => {
    const s = decodeBondingCurve(buf(FIXTURES.curveCurve))!;
    assert.ok(Math.abs(curveEffectiveVSol(s)! - s.virtualSolReserves) < 1e-6);
  });

  it("curveEffectiveVSol puts a Mayhem-mode curve (3.11 virtual SOL, 1.152B tokens) on the standard scale", () => {
    const s = { virtualSolReserves: 3.11055783, virtualTokenReserves: 1_152_230_543.206036, realSolReserves: 0.0015, complete: false };
    const expected = Math.sqrt((3.11055783 / 1_152_230_543.206036) * 1e9 * 32.19);
    assert.ok(Math.abs(curveEffectiveVSol(s)! - expected) < 1e-9);
    assert.equal(curveEffectiveVSol({ ...s, virtualSolReserves: 0 }), null);
  });

  it("rejects a short buffer or a non-boolean complete byte", () => {
    assert.equal(decodeBondingCurve(Buffer.alloc(48)), null);
    const bad = Buffer.from(buf(FIXTURES.curveCurve));
    bad.writeUInt8(7, 48);
    assert.equal(decodeBondingCurve(bad), null);
  });
});

describe("decodePoolVaults (real account)", () => {
  it("returns the meme and WSOL vaults for the pool's own mint", () => {
    assert.deepEqual(decodePoolVaults(buf(FIXTURES.graduatedPool), GRADUATED_MINT), {
      memeVault: "8Y28HCbwvmCmNWW1QtZoQrHpyQHT5oP1P4CaDhj1zexu",
      solVault: "3e5b1kZJVYDHB4c1ACZfg8BnFRNbnaUcHrFpnBiQwfkD",
    });
  });

  it("rejects the pool for any other mint, and a short buffer", () => {
    assert.equal(decodePoolVaults(buf(FIXTURES.graduatedPool), "DsvGsYXbhen27P3F49WS3Gd71y3Gq4WxLbmPyiL6pump"), null);
    assert.equal(decodePoolVaults(Buffer.alloc(202), GRADUATED_MINT), null);
  });
});

describe("decodePool — virtual SOL reserve", () => {
  it("reads the 17.58 SOL virtual reserve of a newer pool", () => {
    const p = decodePool(buf(VIRTUAL_POOL_B64), VIRTUAL_POOL_MINT)!;
    assert.equal(p.virtualQuoteLamports, 17_584_505_289n);
    assert.equal(p.solVault, "Ca1hpehR3HBPzbQZYh2jk1qDzf6wdHPmGJDjHENnpwuW");
  });

  it("the virtual reserve is what makes a real swap consistent with the pool price", () => {
    // Real sell at 12:06:10 on that pool: SOL vault 35.842 -> 34.739, token vault
    // 332.1M -> 339.1M, executed at 1.5754e-7 SOL per token.
    const V = 17.584505289;
    const exec = 1.5754e-7;
    const withV = [(35.842 + V) / 332.1e6, (34.739 + V) / 339.1e6];
    const rawOnly = [35.842 / 332.1e6, 34.739 / 339.1e6];
    assert.ok(exec <= withV[0]! && exec >= withV[1]!, "execution lies between spot before and after");
    assert.ok(exec > rawOnly[0]!, "without the virtual reserve the sell would have executed above spot, impossible");
  });

  it("an older pool account (no virtual reserve) decodes with 0", () => {
    assert.equal(decodePool(buf(FIXTURES.graduatedPool), GRADUATED_MINT)!.virtualQuoteLamports, 0n);
  });

  it("an implausible virtual reserve means an unknown layout: no price rather than a wrong one", () => {
    const b = Buffer.from(buf(VIRTUAL_POOL_B64));
    b.writeBigUInt64LE(5_000n * 1_000_000_000n, 245);
    assert.equal(decodePool(b, VIRTUAL_POOL_MINT), null);
  });
});

describe("pool price → effective vSol", () => {
  const tokenAccount = (amount: bigint) => {
    const b = Buffer.alloc(82);
    b.writeBigUInt64LE(amount, 64);
    return b;
  };

  it("reads SPL token amounts and prices the pool exactly as jsonParsed did", () => {
    const meme = decodeTokenAccountAmount(tokenAccount(669_116_757_860_470n))!;
    const sol = decodeTokenAccountAmount(tokenAccount(42_891_806_783n))!;
    const price = poolPriceSol(sol, meme)!;
    assert.ok(Math.abs(price - 42.891806783 / 669_116_757.86047) < 1e-18);
  });

  it("the effective vSol of a curve's own spot price is its vSol (no SOL/USD involved)", () => {
    for (const vSol of [30, 46.9, 85.3, 115]) {
      const k = 30 * 1_073_000_000;
      const price = (vSol * vSol) / k;
      assert.ok(Math.abs(effectiveVSolFromPriceSol(price)! - vSol) < 1e-6, `vSol ${vSol}`);
    }
  });

  it("empty reserves and unusable prices give null", () => {
    assert.equal(poolPriceSol(0n, 5n), null);
    assert.equal(poolPriceSol(5n, 0n), null);
    assert.equal(effectiveVSolFromPriceSol(0), null);
    assert.equal(effectiveVSolFromPriceSol(Number.NaN), null);
    assert.equal(decodeTokenAccountAmount(Buffer.alloc(71)), null);
  });
});
