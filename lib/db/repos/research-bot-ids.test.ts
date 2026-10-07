import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { bigintIdOrNull } from "@/lib/db/repos/research-bot";

/**
 * A missing JSONB key must never reach a ::bigint parameter.
 *
 * research-trader builds query arguments with `String(f.session_id)`, where `f`
 * is a position's entry_features. A position whose features lack `session_id`
 * — one opened by the general paper executor rather than the research lane —
 * turns that into the literal STRING "undefined", which Postgres then rejects:
 *
 *     invalid input syntax for type bigint: "undefined"
 *
 * Observed once at worker boot against a database holding such a position. It
 * aborted the whole auto-trader tick, so every exit decision in that tick was
 * skipped — the failure is silent in the sense that nothing says WHICH
 * positions went unmanaged.
 *
 * `undefined` itself is NOT the same failure: it binds as a missing parameter
 * and raises a syntax error. Only the stringified form produces this one, which
 * is why String() is the bug and not the null handling.
 */
describe("bigintIdOrNull", () => {
  it("rejects the stringified forms of nothing", () => {
    for (const bad of ["undefined", "null", "NaN", "", "   "]) {
      assert.equal(bigintIdOrNull(bad), null, `${JSON.stringify(bad)} must not reach a bigint`);
    }
  });

  it("rejects actual nothing", () => {
    assert.equal(bigintIdOrNull(undefined), null);
    assert.equal(bigintIdOrNull(null), null);
    assert.equal(bigintIdOrNull(NaN), null);
  });

  it("rejects anything that is not a whole positive id", () => {
    for (const bad of ["12.5", "-3", "0", "1e3", "12abc", "0x1f", {}, []]) {
      assert.equal(bigintIdOrNull(bad as unknown), null, `${JSON.stringify(bad)} is not an id`);
    }
  });

  it("accepts real ids, as string or number, and normalises to a string", () => {
    assert.equal(bigintIdOrNull("42"), "42");
    assert.equal(bigintIdOrNull(42), "42");
    assert.equal(bigintIdOrNull(" 42 "), "42");
    assert.equal(bigintIdOrNull(42n), "42");
  });

  it("accepts an id beyond Number.MAX_SAFE_INTEGER without rounding it", () => {
    // bigserial can exceed 2^53; coercing through Number would silently change it.
    assert.equal(bigintIdOrNull("9007199254740993"), "9007199254740993");
  });
});
