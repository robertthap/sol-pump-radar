import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import { join } from "path";
import { parseProgramLogs, type ParsedTradeEvent } from "@/lib/pump/parser";

// Real mainnet transaction logs, captured 2026-09-13.
type LogFixture = { signature: string; logs: string[] };
const FIX = JSON.parse(readFileSync(join(__dirname, "__fixtures__", "trade-logs.json"), "utf8")) as Record<
  | "launchlab_plus_pump"
  | "mayhem_buy"
  | "zero_reserve_buy"
  // Both captured 2026-09-27: transactions that emit TWO pump events at once.
  | "graduation_buy"
  | "create_with_dev_buy",
  LogFixture
>;

const trades = (f: LogFixture) =>
  parseProgramLogs(f.logs, f.signature, 1n, 1_788_847_000, "local").filter(
    (e): e is ParsedTradeEvent => e.kind === "buy" || e.kind === "sell",
  );

describe("parseProgramLogs — only pump.fun's own TradeEvents", () => {
  it("ignores a Raydium LaunchLab TradeEvent that shares the discriminator (was stored as a 793,100 SOL buy)", () => {
    const t = trades(FIX.launchlab_plus_pump);
    assert.equal(t.length, 1, "only the pump.fun trade in this transaction");
    assert.equal(t[0]!.mint.slice(0, 8), "BndLoV8J");
    assert.ok(t.every((e) => e.solAmount < 1000));
  });

  it("on the standard curve, the stored vSol equals the raw virtual SOL reserve", () => {
    const [t] = trades(FIX.launchlab_plus_pump);
    // raw virtual_sol_reserves 41.071270626 SOL, virtual tokens 783,759,540.345415
    assert.ok(Math.abs(t!.vSolAfter! - 41.071270626) < 1e-3, `got ${t!.vSolAfter}`);
  });
});

describe("parseProgramLogs — non-standard curves", () => {
  it("a Mayhem-mode trade is stored on the curve-equivalent scale, not its raw 14.4 SOL reserve", () => {
    const [t] = trades(FIX.mayhem_buy);
    assert.equal(t!.mint.slice(0, 8), "EecawWtS");
    // price = 14.445242263 SOL / 942,056,136.195479 tokens
    const expected = Math.sqrt((14.445242263 / 942_056_136.195479) * 1e9 * 32.19);
    assert.ok(Math.abs(t!.vSolAfter! - expected) < 1e-6, `got ${t!.vSolAfter}, want ${expected}`);
    assert.ok(t!.vSolAfter! > 20, "no longer below the curve's physical minimum");
  });

  it("a trade with zero virtual SOL stores no price rather than 0", () => {
    const t = trades(FIX.zero_reserve_buy);
    assert.equal(t.length, 1);
    assert.equal(t[0]!.vSolAfter, null);
  });
});

describe("parseProgramLogs — one transaction, two events", () => {
  // `events` is unique on (signature, instruction_index) and every pump event was
  // written at index 0, so the second event of a transaction lost the conflict and
  // was never stored. Measured on the live feed 2026-09-27, before the fix: zero
  // `migrate` rows across 1.09M signatures, and zero of 2,147 creates had their
  // dev buy. Both are single transactions that carry two events.
  const parse = (f: LogFixture) => parseProgramLogs(f.logs, f.signature, 1n, 1_788_847_000, "local");

  it("the buy that fills the curve carries the graduation, and the two get distinct indices", () => {
    const events = parse(FIX.graduation_buy);
    assert.deepEqual(events.map((e) => e.kind), ["buy", "migrate"]);
    assert.deepEqual(events.map((e) => e.logIndex), [0, 1]);
  });

  it("a create carries the dev's first buy, and the two get distinct indices", () => {
    const events = parse(FIX.create_with_dev_buy);
    assert.deepEqual(events.map((e) => e.kind), ["create", "buy"]);
    assert.deepEqual(events.map((e) => e.logIndex), [0, 1]);
  });

  it("the first event of a transaction stays at 0, so rows written before the fix keep their dedupe key", () => {
    for (const f of [FIX.launchlab_plus_pump, FIX.mayhem_buy, FIX.zero_reserve_buy]) {
      assert.equal(parse(f)[0]!.logIndex, 0);
    }
  });
});
