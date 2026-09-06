import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseWatchlistInput } from "@/lib/watchlist/parse";

// Two real addresses from the operator's list, and one real Ethereum address
// from their first (wrong-chain) attempt.
const SOL_A = "GijFWw4oNyh9ko3FaZforNsi3jk6wDovARpkKahPD4o5";
const SOL_B = "56S29mZ3wqvw8hATuUUFqKhGcSGYFASRRFNT38W8q7G3";
const EVM = "0x28c6c06298d514db089934071355e5743bf21d60";

describe("parseWatchlistInput", () => {
  it("accepts valid base58 Solana addresses", () => {
    const r = parseWatchlistInput(`${SOL_A}\n${SOL_B}`);
    assert.deepEqual(r.accepted, [SOL_A, SOL_B]);
    assert.equal(r.rejected.length, 0);
  });

  // The whole reason this module exists. Silently storing these is what makes a
  // strategy look like it "just never triggers".
  it("rejects an Ethereum address by name, not as a generic parse failure", () => {
    const r = parseWatchlistInput(EVM);
    assert.equal(r.accepted.length, 0);
    assert.equal(r.rejected.length, 1);
    assert.match(r.rejected[0].reason, /Ethereum address/);
    assert.match(r.rejected[0].reason, /Solana/);
    assert.equal(r.rejected[0].input, EVM, "the reason must name which input failed");
  });

  it("rejects a 0x-prefixed string that is not a well-formed EVM address", () => {
    const r = parseWatchlistInput("0xdeadbeef");
    assert.equal(r.rejected.length, 1);
    assert.match(r.rejected[0].reason, /0x/);
  });

  it("dedupes repeats without reporting them as failures", () => {
    // The operator's paste contained 5t4Tz7qe.. twice.
    const r = parseWatchlistInput(`${SOL_A} ${SOL_A} ${SOL_B}`);
    assert.deepEqual(r.accepted, [SOL_A, SOL_B]);
    assert.deepEqual(r.duplicates, [SOL_A]);
    assert.equal(r.rejected.length, 0, "a duplicate is a paste artifact, not an error");
  });

  it("splits on newlines, commas, semicolons and runs of whitespace alike", () => {
    const r = parseWatchlistInput(`  ${SOL_A} ,\n\n${SOL_B};  `);
    assert.deepEqual(r.accepted, [SOL_A, SOL_B]);
  });

  it("names the confusable character when base58 is violated", () => {
    // Same length as a real address but with an 'O', which base58 excludes.
    const r = parseWatchlistInput("O" + SOL_A.slice(1));
    assert.equal(r.rejected.length, 1);
    assert.match(r.rejected[0].reason, /base58/);
  });

  it("reports length for a truncated address rather than a bare 'invalid'", () => {
    const r = parseWatchlistInput(SOL_A.slice(0, 20));
    assert.match(r.rejected[0].reason, /too short \(20 chars/);
  });

  it("returns empty sets for empty or whitespace-only input", () => {
    for (const s of ["", "   ", "\n\n , ; "]) {
      const r = parseWatchlistInput(s);
      assert.deepEqual(r.accepted, []);
      assert.deepEqual(r.rejected, []);
    }
  });

  it("caps a runaway paste at 500 addresses", () => {
    const r = parseWatchlistInput(Array(600).fill(SOL_A).join("\n"));
    // 500 tokens read, all the same address, so one accepted and 499 duplicates.
    assert.equal(r.accepted.length + r.duplicates.length, 500);
  });

  it("keeps the whole batch when only some entries are bad", () => {
    const r = parseWatchlistInput(`${SOL_A}\n${EVM}\n${SOL_B}`);
    assert.deepEqual(r.accepted, [SOL_A, SOL_B], "one bad paste must not discard the good ones");
    assert.equal(r.rejected.length, 1);
  });
});
