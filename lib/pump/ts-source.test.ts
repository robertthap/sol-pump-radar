import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import { join } from "path";
import { parseProgramLogs, type ParsedTradeEvent } from "@/lib/pump/parser";
import { parseSwapLogs } from "@/lib/pump/pumpswap-parser";
import { EVENT_DISCRIMINATORS } from "@/lib/pump/program";

/**
 * ts_source provenance regression.
 *
 * The invariant under test: a timestamp that was produced locally — either the
 * caller's clock, or the parser's fallback after an unusable on-chain value —
 * must NEVER be recorded as "chain". Provenance is decided where the fallback
 * actually happens (the parser), not re-inferred later from whether the final
 * number looks plausible.
 */

const LOCAL_TS = 1_700_000_000; // caller's clock, in seconds
const CHAIN_TS = 1_699_999_000; // a genuine, plausible on-chain second

// ── minimal Borsh encoders matching lib/rpc/borsh.ts ──────────────────────────
const u64 = (v: bigint | number) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(v));
  return b;
};
const i64 = (v: bigint | number) => {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(BigInt(v));
  return b;
};
const bool = (v: boolean) => Buffer.from([v ? 1 : 0]);
const pubkey = (fill: number) => Buffer.alloc(32, fill);
const str = (s: string) => {
  const body = Buffer.from(s, "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32LE(body.length);
  return Buffer.concat([len, body]);
};
const logLine = (disc: Buffer, body: Buffer) =>
  "Program data: " + Buffer.concat([disc, body]).toString("base64");

/** TradeEvent: mint, solAmount, tokenAmount, isBuy, user, ts, vSol, (unused u64). */
const tradeLog = (ts: number | bigint) =>
  logLine(
    EVENT_DISCRIMINATORS.trade,
    Buffer.concat([
      pubkey(1), u64(1_000_000_000), u64(5_000_000), bool(true),
      pubkey(2), i64(ts), u64(31_000_000_000), u64(0),
    ]),
  );

/** CreateEvent: name, symbol, uri, mint, bondingCurve, user — carries NO timestamp. */
const createLog = () =>
  logLine(
    EVENT_DISCRIMINATORS.create,
    Buffer.concat([str("Test"), str("TST"), str("ipfs://x"), pubkey(1), pubkey(3), pubkey(2)]),
  );

/** CompleteEvent: user, mint, bondingCurve — carries NO timestamp. */
const completeLog = () =>
  logLine(EVENT_DISCRIMINATORS.complete, Buffer.concat([pubkey(2), pubkey(1), pubkey(3)]));

const parseOne = (line: string, ts: number, source?: "chain" | "local") =>
  parseProgramLogs([line], "sig", 1n, ts, source);

describe("ts_source provenance", () => {
  // Test 1 — a valid on-chain timestamp is chain time.
  it("valid on-chain trade timestamp -> chain", () => {
    const [ev] = parseOne(tradeLog(CHAIN_TS), LOCAL_TS, "local");
    assert.equal(ev.tsSource, "chain");
    assert.equal(ev.blockTime, CHAIN_TS);
  });

  // Test 2 — no usable on-chain timestamp, caller clock used instead.
  it("missing on-chain trade timestamp -> local (caller clock)", () => {
    const [ev] = parseOne(tradeLog(0), LOCAL_TS, "local");
    assert.equal(ev.tsSource, "local");
    assert.equal(ev.blockTime, LOCAL_TS);
  });

  // Test 3 — THE core regression. The fallback value is perfectly plausible, so
  // any classifier that inspects the resulting number would call it "chain".
  it("implausible on-chain timestamp -> local, never 'chain' just because the fallback looks fine", () => {
    for (const bad of [1, -1, 999_999_999, Math.floor(Date.now() / 1000) + 86_400]) {
      const [ev] = parseOne(tradeLog(bad), LOCAL_TS, "local");
      assert.equal(ev.tsSource, "local", `raw=${bad} must fall back to local`);
      assert.equal(ev.blockTime, LOCAL_TS, "fallback value is the plausible caller clock");
    }
  });

  // Test 4 — create events carry no on-chain time at all.
  it("create event -> local on the caller-clock path", () => {
    const [ev] = parseOne(createLog(), LOCAL_TS, "local");
    assert.equal(ev.kind, "create");
    assert.equal(ev.tsSource, "local");
  });

  // Test 5 — complete/migrate events carry no on-chain time at all.
  it("complete event -> local on the caller-clock path", () => {
    const [ev] = parseOne(completeLog(), LOCAL_TS, "local");
    assert.equal(ev.kind, "migrate");
    assert.equal(ev.tsSource, "local");
  });

  // Test 6 — PumpSwap, against a captured real transaction.
  it("pumpswap swap -> local (decodeSwap uses the caller clock)", () => {
    const fixtures: Array<{ programDataB64: string; slot: number }> = JSON.parse(
      readFileSync(join(__dirname, "__fixtures__", "pumpswap-swaps.json"), "utf8"),
    );
    const raws = parseSwapLogs(
      ["Program data: " + fixtures[0].programDataB64],
      "sig",
      BigInt(fixtures[0].slot),
      LOCAL_TS,
      "local",
    );
    assert.equal(raws.length, 1);
    assert.equal(raws[0].tsSource, "local");
    assert.equal(raws[0].blockTime, LOCAL_TS);
  });

  // Test 7 — gap recovery replays a real tx.blockTime, so its fallback IS chain
  // time. A create event has no embedded ts, so it inherits the caller's source.
  it("gap recovery: caller-supplied chain time propagates to events with no embedded ts", () => {
    const [created] = parseOne(createLog(), CHAIN_TS, "chain");
    assert.equal(created.tsSource, "chain");

    const [migrated] = parseOne(completeLog(), CHAIN_TS, "chain");
    assert.equal(migrated.tsSource, "chain");

    // A trade whose own ts is unusable also inherits the caller's chain fallback.
    const [traded] = parseOne(tradeLog(0), CHAIN_TS, "chain");
    assert.equal(traded.tsSource, "chain");
    assert.equal(traded.blockTime, CHAIN_TS);

    // ...but when the caller only had its own clock, it stays local.
    const [local] = parseOne(tradeLog(0), LOCAL_TS, "local");
    assert.equal(local.tsSource, "local");
  });

  it("defaults to local when the caller does not declare a source", () => {
    // Fail-closed: an un-migrated caller must never accidentally claim chain time.
    const [ev] = parseOne(createLog(), LOCAL_TS);
    assert.equal(ev.tsSource, "local");
  });

  it("a genuine on-chain ts still wins over a chain-sourced caller fallback", () => {
    const [ev] = parseOne(tradeLog(CHAIN_TS), LOCAL_TS, "chain") as ParsedTradeEvent[];
    assert.equal(ev.tsSource, "chain");
    assert.equal(ev.blockTime, CHAIN_TS, "the event's own ts, not the caller's");
  });
});
