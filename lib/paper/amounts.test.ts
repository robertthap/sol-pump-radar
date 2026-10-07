import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  LAMPORTS_PER_SOL, MAX_SAFE_SOL,
  solToLamports, lamportsToSol, tokensToRaw, rawToTokens, rawToDecimalString,
  sumLamports, applyBpsExact,
} from "@spr/trading";

/**
 * M04 — integer math for lamports and raw token amounts.
 *
 * Decimals, dust and large values are the three ways a double quietly lies
 * about money, so each gets its own cases.
 */
describe("exact amounts (M04)", () => {
  describe("decimals", () => {
    it("the classic float error does not reach the ledger", () => {
      // 0.1 + 0.2 === 0.30000000000000004 as doubles.
      const sum = sumLamports([solToLamports(0.1), solToLamports(0.2)]);
      assert.equal(sum, solToLamports(0.3));
      assert.equal(sum, 300_000_000n);
    });

    it("a hundred small amounts sum exactly, where doubles drift", () => {
      const exact = sumLamports(Array.from({ length: 100 }, () => solToLamports(0.01)));
      assert.equal(exact, solToLamports(1));
      assert.equal(lamportsToSol(exact), 1);
    });

    it("one SOL is exactly one billion lamports", () => {
      assert.equal(solToLamports(1), LAMPORTS_PER_SOL);
      assert.equal(lamportsToSol(LAMPORTS_PER_SOL), 1);
    });

    it("rounds half AWAY from zero, symmetrically", () => {
      // Math.round is half-up, so -0.5 would become -0 and lose the cost.
      assert.equal(solToLamports(0.0000000005), 1n);
      assert.equal(solToLamports(-0.0000000005), -1n);
    });

    it("round-trips a representable amount at every token precision", () => {
      for (const decimals of [1, 6, 9]) {
        const raw = tokensToRaw(1.5, decimals);
        assert.equal(rawToTokens(raw, decimals), 1.5, `decimals=${decimals}`);
      }
    });

    it("a precision that cannot hold the amount rounds it, it does not pretend", () => {
      // At 0 decimals the smallest unit IS one token, so 1.5 is not representable.
      assert.equal(tokensToRaw(1.5, 0), 2n);
      assert.equal(tokensToRaw(1.4, 0), 1n);
    });

    it("rejects an impossible decimals value instead of silently scaling wrong", () => {
      assert.throws(() => tokensToRaw(1, -1), RangeError);
      assert.throws(() => tokensToRaw(1, 19), RangeError);
      assert.throws(() => tokensToRaw(1, 1.5), RangeError);
    });
  });

  describe("dust", () => {
    it("below one raw unit is zero, not a token that does not exist", () => {
      assert.equal(tokensToRaw(0.0000004, 6), 0n); // 0.4 raw units
      assert.equal(tokensToRaw(0.0000006, 6), 1n); // 0.6 raw units
    });

    it("a sub-lamport amount cannot become a lamport it is not", () => {
      assert.equal(solToLamports(0.0000000004), 0n);
      assert.equal(solToLamports(0), 0n);
    });

    it("a fee on dust rounds UP, never in our favour", () => {
      // 1 lamport at 1.25% is 0.0125 lamports — charge 1, not 0.
      assert.equal(applyBpsExact(1n, 125), 1n);
      assert.equal(applyBpsExact(0n, 125), 0n);
    });

    it("an exact fee is not inflated by the rounding rule", () => {
      assert.equal(applyBpsExact(10_000n, 125), 125n); // divides evenly
      assert.equal(applyBpsExact(80n, 125), 1n); // 1.0 exactly
    });
  });

  describe("large values", () => {
    it("a whole 1e9 token supply at 6 decimals stays exact", () => {
      const supply = 1_000_000_000n * 1_000_000n; // 1e15 raw, near MAX_SAFE_INTEGER
      assert.equal(rawToDecimalString(supply, 6), "1000000000.000000");
      assert.equal(sumLamports([supply, 1n]), supply + 1n);
    });

    it("an amount beyond double precision survives as a string", () => {
      // 2^53 + 1 raw units: Number() cannot represent this, BigInt can.
      const raw = 9_007_199_254_740_993n;
      assert.equal(rawToDecimalString(raw, 6), "9007199254.740993");
      assert.notEqual(BigInt(Math.round(rawToTokens(raw, 6) * 1e6)), raw);
    });

    it("refuses a SOL amount too large to convert exactly", () => {
      assert.throws(() => solToLamports(MAX_SAFE_SOL * 2), RangeError);
      assert.throws(() => solToLamports(Infinity), RangeError);
      assert.throws(() => solToLamports(NaN), RangeError);
    });

    it("refuses a token amount too large to convert exactly", () => {
      assert.throws(() => tokensToRaw(1e18, 9), RangeError);
    });

    it("summing many large values does not drift", () => {
      const big = 1_000_000_000_000_000n;
      const total = sumLamports(Array.from({ length: 1000 }, () => big));
      assert.equal(total, 1_000_000_000_000_000_000n);
    });
  });

  describe("exact decimal strings", () => {
    it("pads the fraction so digits are never dropped", () => {
      assert.equal(rawToDecimalString(1n, 6), "0.000001");
      assert.equal(rawToDecimalString(1_000_000n, 6), "1.000000");
      assert.equal(rawToDecimalString(1_500_000n, 6), "1.500000");
    });

    it("keeps the sign and never uses exponent notation", () => {
      assert.equal(rawToDecimalString(-1n, 9), "-0.000000001");
      assert.ok(!rawToDecimalString(1n, 18).includes("e"));
    });

    it("zero decimals has no point", () => {
      assert.equal(rawToDecimalString(42n, 0), "42");
    });
  });
});
