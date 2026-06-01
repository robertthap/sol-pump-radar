import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertTransition } from "./trade-state";

describe("trade FSM", () => {
  it("allows INTENT -> OPEN", () => {
    assert.doesNotThrow(() => assertTransition("INTENT", "OPEN"));
  });

  it("blocks INTENT -> CLOSED", () => {
    assert.throws(() => assertTransition("INTENT", "CLOSED"));
  });

  it("blocks CLOSED -> OPEN", () => {
    assert.throws(() => assertTransition("CLOSED", "OPEN"));
  });
});
