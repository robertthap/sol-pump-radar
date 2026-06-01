import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTransition, isTerminal, InvalidTransitionError } from "./index";

test("position FSM: legal transitions", () => {
  assertTransition("INTENT", "OPEN");
  assertTransition("INTENT", "FAILED");
  assertTransition("OPEN", "CLOSING");
  assertTransition("OPEN", "FAILED");
  assertTransition("CLOSING", "CLOSED");
  assertTransition("CLOSING", "FAILED");
});

test("position FSM: rejects illegal transitions", () => {
  assert.throws(() => assertTransition("INTENT", "CLOSED"), InvalidTransitionError);
  assert.throws(() => assertTransition("OPEN", "INTENT"), InvalidTransitionError);
  assert.throws(() => assertTransition("CLOSED", "OPEN"), InvalidTransitionError);
  assert.throws(() => assertTransition("CLOSED", "FAILED"), InvalidTransitionError);
  assert.throws(() => assertTransition("FAILED", "OPEN"), InvalidTransitionError);
});

test("position FSM: terminal states", () => {
  assert.equal(isTerminal("INTENT"), false);
  assert.equal(isTerminal("OPEN"), false);
  assert.equal(isTerminal("CLOSING"), false);
  assert.equal(isTerminal("CLOSED"), true);
  assert.equal(isTerminal("FAILED"), true);
});
