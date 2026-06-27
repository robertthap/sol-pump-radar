import { test } from "node:test";
import assert from "node:assert/strict";
import { computePSI, metaShiftDetected, maxPsi, META_SHIFT_PSI_THRESHOLD } from "./drift";

// Deterministic pseudo-random so tests are stable.
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}
function sample(n: number, fn: (r: number) => number, seed: number): number[] {
  const r = rng(seed);
  return Array.from({ length: n }, () => fn(r()));
}

test("PSI: identical distributions → ~0", () => {
  const a = sample(2000, (u) => u * 100, 1);
  const b = sample(2000, (u) => u * 100, 2); // same generating process, diff seed
  const psi = computePSI(a, b);
  assert.ok(psi < 0.1, `expected PSI < 0.1 for same distribution, got ${psi.toFixed(4)}`);
});

test("PSI: a clear shift (uniform 0-100 → uniform 50-150) crosses the meta-shift threshold", () => {
  const base = sample(2000, (u) => u * 100, 3);
  const shifted = sample(2000, (u) => 50 + u * 100, 4);
  const psi = computePSI(base, shifted);
  assert.ok(psi > META_SHIFT_PSI_THRESHOLD, `expected PSI > ${META_SHIFT_PSI_THRESHOLD}, got ${psi.toFixed(4)}`);
});

test("PSI: a mild shift stays moderate (below threshold)", () => {
  const base = sample(3000, (u) => u * 100, 5);
  const mild = sample(3000, (u) => 5 + u * 100, 6); // small +5 shift
  const psi = computePSI(base, mild);
  assert.ok(psi < META_SHIFT_PSI_THRESHOLD, `expected mild shift PSI < ${META_SHIFT_PSI_THRESHOLD}, got ${psi.toFixed(4)}`);
});

test("PSI: monotonic in shift magnitude", () => {
  const base = sample(3000, (u) => u * 100, 7);
  const small = sample(3000, (u) => 20 + u * 100, 8);
  const large = sample(3000, (u) => 80 + u * 100, 9);
  const psiSmall = computePSI(base, small);
  const psiLarge = computePSI(base, large);
  assert.ok(psiLarge > psiSmall, `larger shift should have larger PSI: ${psiLarge.toFixed(3)} vs ${psiSmall.toFixed(3)}`);
});

test("PSI: empty input → 0 (no crash)", () => {
  assert.equal(computePSI([], [1, 2, 3]), 0);
  assert.equal(computePSI([1, 2, 3], []), 0);
});

test("PSI: constant baseline → 0 (no distribution to shift)", () => {
  const base = new Array(100).fill(42);
  const cur = sample(100, (u) => u * 10, 10);
  assert.equal(computePSI(base, cur), 0);
});

test("PSI: never negative", () => {
  for (let s = 1; s <= 20; s++) {
    const a = sample(500, (u) => u * 50, s);
    const b = sample(500, (u) => u * 70 - 10, s + 100);
    assert.ok(computePSI(a, b) >= 0);
  }
});

test("metaShiftDetected / maxPsi over a feature map", () => {
  const calm = { dex_vol_m5: 0.04, dex_liq_usd: 0.08, grad_score: 0.02 };
  assert.equal(metaShiftDetected(calm), false);
  assert.ok(maxPsi(calm) < META_SHIFT_PSI_THRESHOLD);

  const shifted = { dex_vol_m5: 0.04, dex_liq_usd: 0.31, grad_score: 0.02 };
  assert.equal(metaShiftDetected(shifted), true, "one feature over 0.25 → meta shift");
  assert.ok(Math.abs(maxPsi(shifted) - 0.31) < 1e-9);
});
