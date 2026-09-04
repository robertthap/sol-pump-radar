import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveTimingAgeSeconds,
  decisionAgeSeconds,
  TIMING_GATE_MAX_AGE_SEC,
} from "@/lib/trade/timing-age";

/**
 * Pins the ACTUAL semantics of the value stored as entry_features.entry_age_seconds.
 *
 * It was documented as "token age at entry — our reaction time", but it is
 * min(flowAge, decisionAge) and degrades to decisionAge (pending-queue wait) once
 * a token is older than the timing gate. Reports must not present it as a clean
 * reaction latency; `decision_to_intent_ms` is the unambiguous stage metric.
 */
const secondsAgo = (s: number) => new Date(Date.now() - s * 1000).toISOString();
const near = (actual: number, expected: number, tol = 2) =>
  assert.ok(Math.abs(actual - expected) <= tol, `expected ~${expected}, got ${actual}`);

describe("resolveTimingAgeSeconds — entry_age_seconds semantics", () => {
  it("uses flow age when it is younger than the queue wait (fresh launch)", () => {
    // token 5s old, decision committed 30s ago -> min() picks the token age.
    near(resolveTimingAgeSeconds(5, secondsAgo(30)), 5);
  });

  it("uses the queue wait when it is the smaller of the two", () => {
    // token 120s old, decision only 8s ago -> min() picks the queue wait.
    near(resolveTimingAgeSeconds(120, secondsAgo(8)), 8);
  });

  it("DEGRADES to pure queue wait once the token exceeds the timing gate", () => {
    // This is the live-observed case: a token far older than the gate reports the
    // queue wait, so the value is NOT the token's age at all.
    const queueWaitSec = 7.4;
    const out = resolveTimingAgeSeconds(TIMING_GATE_MAX_AGE_SEC + 1, secondsAgo(queueWaitSec));
    near(out, queueWaitSec);
  });

  it("degrades to queue wait when flow age is missing or invalid", () => {
    for (const bad of [null, undefined, Number.NaN, -1]) {
      near(resolveTimingAgeSeconds(bad, secondsAgo(12)), 12);
    }
  });

  it("is therefore NOT equivalent to token age — the documented trap", () => {
    const tokenAgeSec = 175; // real token age
    const queueWaitSec = 8; // real queue wait
    const reported = resolveTimingAgeSeconds(tokenAgeSec, secondsAgo(queueWaitSec));
    assert.notEqual(Math.round(reported), tokenAgeSec);
    near(reported, queueWaitSec);
  });

  it("decisionAgeSeconds measures decision -> now, the queue-wait stage", () => {
    near(decisionAgeSeconds(secondsAgo(45)), 45);
    assert.equal(decisionAgeSeconds("not-a-date"), 0, "unparseable is 0, never negative");
    assert.ok(decisionAgeSeconds(new Date(Date.now() + 60_000)) >= 0, "future ts clamps at 0");
  });
});

describe("decision_to_intent_ms — the unambiguous replacement", () => {
  // The auto-trader computes: max(0, intent.createdAtMs - Date.parse(decision.ts)).
  const decisionToIntentMs = (decisionTs: string, intentAtMs: number) =>
    Math.max(0, intentAtMs - Date.parse(decisionTs));

  it("measures exactly the decision -> intent stage, independent of token age", () => {
    const decisionTs = "2026-09-04T00:25:36.000Z";
    const intentAt = Date.parse("2026-09-04T00:25:44.700Z");
    assert.equal(decisionToIntentMs(decisionTs, intentAt), 8_700);
  });

  it("is unaffected by how old the token is", () => {
    // Same decision->intent gap must yield the same value for a 5s-old and a
    // 5-hour-old token — which is precisely what entry_age_seconds fails to do.
    const decisionTs = "2026-09-04T00:00:00.000Z";
    const intentAt = Date.parse("2026-09-04T00:00:09.000Z");
    assert.equal(decisionToIntentMs(decisionTs, intentAt), 9_000);
  });

  it("clamps a clock skew to 0 rather than reporting negative latency", () => {
    const decisionTs = "2026-09-04T00:00:10.000Z";
    const intentAt = Date.parse("2026-09-04T00:00:00.000Z");
    assert.equal(decisionToIntentMs(decisionTs, intentAt), 0);
  });
});
