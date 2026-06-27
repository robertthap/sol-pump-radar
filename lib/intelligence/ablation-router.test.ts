import { test } from "node:test";
import assert from "node:assert/strict";
import {
  variantEnters,
  seededUnit,
  V0_RANDOM_RATE,
  type AblationFeatures,
} from "./ablation-router";

// A clean entry that passes every gate.
const GOOD: AblationFeatures = {
  intelligence: 0.8,
  rug: 0.1,
  insider: 0.1,
  wash: 0.1,
  creator: 0.2,
  grad: 0.6,
  engineA: 0,
  autoAllowed: 1,
};

test("V1–V4 form a strict nesting: each adds a filter that can only remove entries", () => {
  // A snapshot that V1 admits should be re-checked by V2..V4; if a later gate
  // fails, the earlier ones still passed (monotone tightening).
  const rugHeavy: AblationFeatures = { ...GOOD, rug: 0.9, autoAllowed: 0 };
  assert.equal(variantEnters("V1", rugHeavy, "s"), true, "V1 ignores rug");
  assert.equal(variantEnters("V2", rugHeavy, "s"), false, "V2 vetoes rug");
  assert.equal(variantEnters("V3", rugHeavy, "s"), false, "V3 still vetoes rug");
  assert.equal(variantEnters("V4", rugHeavy, "s"), false);
});

test("M2/M5/M4 vetoes only engage at V3+", () => {
  const insider: AblationFeatures = { ...GOOD, insider: 0.7, autoAllowed: 0 };
  assert.equal(variantEnters("V2", insider, "s"), true, "V2 has no insider veto");
  assert.equal(variantEnters("V3", insider, "s"), false, "V3 adds insider veto");

  const wash: AblationFeatures = { ...GOOD, wash: 0.8, autoAllowed: 0 };
  assert.equal(variantEnters("V2", wash, "s"), true);
  assert.equal(variantEnters("V3", wash, "s"), false);
});

test("V4 adds the graduation floor", () => {
  const lowGrad: AblationFeatures = { ...GOOD, grad: 0.1, autoAllowed: 0 };
  assert.equal(variantEnters("V3", lowGrad, "s"), true, "V3 has no grad floor");
  assert.equal(variantEnters("V4", lowGrad, "s"), false, "V4 adds grad floor");
});

test("V5 = V4 OR Engine-A: an engine_a signal is admitted even if V4 rejects", () => {
  const lowGradEngineA: AblationFeatures = { ...GOOD, grad: 0.1, engineA: 1, autoAllowed: 0 };
  assert.equal(variantEnters("V4", lowGradEngineA, "s"), false, "V4 rejects (low grad)");
  assert.equal(variantEnters("V5", lowGradEngineA, "s"), true, "V5 admits via Engine-A");
});

test("V6 follows the live _auto_trade_allowed flag exactly", () => {
  assert.equal(variantEnters("V6", { ...GOOD, autoAllowed: 1 }, "s"), true);
  assert.equal(variantEnters("V6", { ...GOOD, autoAllowed: 0 }, "s"), false);
  // V6 ignores the individual scores — it's the recorded full-system decision
  assert.equal(variantEnters("V6", { ...GOOD, rug: 0.99, autoAllowed: 1 }, "s"), true);
});

test("V0 random is deterministic per snapshot id and ~matches the target rate", () => {
  // Determinism: same id → same decision
  assert.equal(variantEnters("V0", GOOD, "abc"), variantEnters("V0", GOOD, "abc"));
  // Rate: over many ids, the admit fraction is near V0_RANDOM_RATE
  let admitted = 0;
  const N = 20000;
  for (let i = 0; i < N; i++) if (variantEnters("V0", GOOD, `snap-${i}`)) admitted++;
  const rate = admitted / N;
  assert.ok(
    Math.abs(rate - V0_RANDOM_RATE) < 0.02,
    `V0 admit rate ${rate.toFixed(3)} should be ≈ ${V0_RANDOM_RATE}`,
  );
});

test("seededUnit is in [0,1) and stable", () => {
  const u = seededUnit("hello");
  assert.ok(u >= 0 && u < 1);
  assert.equal(seededUnit("hello"), u);
});
