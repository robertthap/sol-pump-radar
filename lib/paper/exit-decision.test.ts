import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decidePaperExit } from "@/lib/paper/exit-decision";

const P = { tpPct: 0.35, slPct: 0.12, maxHoldMs: 35 * 60_000, trailArmPct: 0.15, trailStopPct: 0.08 };

describe("decidePaperExit", () => {
  it("takes full profit at target", () => {
    assert.equal(decidePaperExit(0.40, 0.40, 1000, P), "tp");
  });

  it("stops out at the loss floor", () => {
    assert.equal(decidePaperExit(-0.13, 0.05, 1000, P), "sl");
  });

  it("times out after max hold", () => {
    assert.equal(decidePaperExit(0.02, 0.05, 36 * 60_000, P), "timeout");
  });

  it("holds when nothing is triggered", () => {
    assert.equal(decidePaperExit(0.05, 0.06, 1000, P), null);
  });

  it("trails: armed at +20% peak, exits when it falls 8% below peak", () => {
    // peak 0.20 (≥ arm 0.15); current 0.11 ≤ 0.20-0.08=0.12 → trail
    assert.equal(decidePaperExit(0.11, 0.20, 1000, P), "trail");
  });

  it("does NOT trail before arming (peak below arm)", () => {
    // peak 0.10 < arm 0.15 → trailing not armed; -0.05 not past SL → hold
    assert.equal(decidePaperExit(-0.05, 0.10, 1000, P), null);
  });

  it("does NOT trail while still near the peak", () => {
    // peak 0.20 armed, current 0.16 > 0.12 → no trail yet
    assert.equal(decidePaperExit(0.16, 0.20, 1000, P), null);
  });

  it("trailing disabled (arm/stop 0) falls back to tp/sl/timeout only", () => {
    const noTrail = { ...P, trailArmPct: 0, trailStopPct: 0 };
    assert.equal(decidePaperExit(0.11, 0.20, 1000, noTrail), null);
  });

  it("take-profit wins over trailing when both could fire", () => {
    assert.equal(decidePaperExit(0.40, 0.50, 1000, P), "tp");
  });
});
