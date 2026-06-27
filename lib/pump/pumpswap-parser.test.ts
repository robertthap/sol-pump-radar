import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import { join } from "path";
import { parseSwapLogs, enrichSwap, effectiveVSolFromReserves } from "./pumpswap-parser";
import { WSOL_MINT } from "./program";
import { mcapUsdFromVSolAt } from "@/lib/dex/curve-mcap";
import { PUMP_SUPPLY } from "@/lib/chart/constants";

/**
 * T1.2b gate — captured real PumpSwap txs (validated against on-chain balance
 * deltas during T1.2a discovery) → exact decoded fields. If this fails, the
 * parser drifted from the on-chain layout; do not ship.
 */

type Fixture = {
  signature: string;
  eventType: "BuyEvent" | "SellEvent";
  slot: number;
  blockTime: number;
  programDataB64: string;
  poolBaseMint: string;
  poolQuoteMint: string;
  expected: {
    user: string;
    pool: string;
    memeMint: string;
    baseIsWsol: boolean;
    userSide: "buy" | "sell";
    solAmount: string;        // raw lamports
    tokenAmount: string;      // raw token units
    solReserveAfter: string;  // raw lamports
  };
};

const fixtures: Fixture[] = JSON.parse(
  readFileSync(join(__dirname, "__fixtures__", "pumpswap-swaps.json"), "utf8"),
);

test("fixtures: at least 2 buys + 2 sells captured", () => {
  const buys = fixtures.filter((f) => f.expected.userSide === "buy").length;
  const sells = fixtures.filter((f) => f.expected.userSide === "sell").length;
  assert.ok(buys >= 2, `expected ≥2 user-buy fixtures, got ${buys}`);
  assert.ok(sells >= 2, `expected ≥2 user-sell fixtures, got ${sells}`);
});

for (const fx of fixtures) {
  test(`parseSwapLogs decodes ${fx.eventType} ${fx.signature.slice(0, 10)} to exact fields`, () => {
    // Reconstruct the program-data log line and parse it
    const logLine = "Program data: " + fx.programDataB64;
    const raw = parseSwapLogs([logLine], fx.signature, BigInt(fx.slot), fx.blockTime);
    assert.equal(raw.length, 1, "should decode exactly one swap event");
    const r = raw[0]!;

    // The pure parser fields (no mint/side resolution yet)
    assert.equal(r.eventType, fx.eventType === "BuyEvent" ? "buy" : "sell", "event type");
    assert.equal(r.user, fx.expected.user, "user pubkey");
    assert.equal(r.pool, fx.expected.pool, "pool pubkey");
    assert.equal(r.signature, fx.signature, "signature passthrough");
    assert.equal(r.slot, BigInt(fx.slot), "slot passthrough");
  });

  test(`enrichSwap resolves user side + amounts for ${fx.signature.slice(0, 10)}`, () => {
    const logLine = "Program data: " + fx.programDataB64;
    const raw = parseSwapLogs([logLine], fx.signature, BigInt(fx.slot), fx.blockTime)[0]!;
    const baseIsWsol = fx.poolBaseMint === WSOL_MINT;
    assert.equal(baseIsWsol, fx.expected.baseIsWsol, "baseIsWsol matches fixture");

    const e = enrichSwap(raw, { memeMint: fx.expected.memeMint, baseIsWsol });

    // The decisive validated facts from discovery:
    assert.equal(e.side, fx.expected.userSide, "USER side (validated vs SOL delta sign)");
    assert.equal(e.mint, fx.expected.memeMint, "resolved meme mint");
    assert.equal(e.wallet, fx.expected.user, "wallet");

    // SOL amount: enrichSwap converts lamports→SOL. Compare back to raw lamports.
    const solLamports = Math.round(e.solAmount * 1e9);
    assert.equal(String(solLamports), fx.expected.solAmount, "SOL amount (lamports)");

    // Token amount stays in raw units
    assert.equal(String(Math.round(e.tokenAmount)), fx.expected.tokenAmount, "token amount (raw)");

    // SOL reserve after (lamports → SOL → back)
    const solReserveLamports = Math.round(e.solReserveAfter * 1e9);
    assert.equal(String(solReserveLamports), fx.expected.solReserveAfter, "sol reserve after");
  });
}

test("parseSwapLogs: ignores non-pumpswap program data lines", () => {
  // A random base64 line that isn't a buy/sell discriminator
  const junk = "Program data: " + Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9]).toString("base64");
  const out = parseSwapLogs([junk, "Program log: hello"], "sig", 1n, 100);
  assert.equal(out.length, 0);
});

test("parseSwapLogs: never throws on malformed base64", () => {
  const out = parseSwapLogs(["Program data: !!!not-base64!!!"], "sig", 1n, 100);
  assert.ok(Array.isArray(out));
});

test("effectiveVSolFromReserves: round-trips a known vSol via pool reserves", () => {
  // Pick a target vSol, derive the pool reserves that imply it, then confirm
  // the helper recovers it. mcap_sol = vSol²/CURVE_DIV = price·SUPPLY, and
  // price = solReserve / tokenWhole. SOL-price independent, so use rate=1.
  for (const targetVSol of [40, 85, 150, 300]) {
    const mcapSol = mcapUsdFromVSolAt(targetVSol, 1)!; // rate=1 → mcap in SOL
    const priceSolPerToken = mcapSol / PUMP_SUPPLY;
    const tokenWhole = 1_000_000; // arbitrary token reserve (whole tokens)
    const solReserve = priceSolPerToken * tokenWhole;
    const tokenRaw = tokenWhole * 1e6; // 6 decimals, raw units
    const recovered = effectiveVSolFromReserves(solReserve, tokenRaw)!;
    assert.ok(
      Math.abs(recovered - targetVSol) < 1e-6,
      `expected ${targetVSol}, got ${recovered}`,
    );
  }
});

test("effectiveVSolFromReserves: null on non-positive reserves", () => {
  assert.equal(effectiveVSolFromReserves(0, 1e12), null);
  assert.equal(effectiveVSolFromReserves(10, 0), null);
  assert.equal(effectiveVSolFromReserves(-5, 1e12), null);
});
