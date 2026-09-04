import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decidePaperExit } from "@/lib/paper/exit-decision";

const P = { tpPct: 0.35, slPct: 0.12, maxHoldMs: 35 * 60_000, trailArmPct: 0.15, trailStopPct: 0.08 };

describe("decidePaperExit", () => {
  it("stops out at the loss floor", () => {
    assert.equal(decidePaperExit(-0.13, 0.05, 1000, P), "sl");
  });

  it("lets a winner RUN once the trail is armed — no fixed TP cap", () => {
    // +40% at its peak, trail armed (peak ≥ 0.15): hold and ride, not capped at tpPct.
    assert.equal(decidePaperExit(0.4, 0.4, 1000, P), null);
  });

  it("rides up then trails out below the peak (captures more than the old TP)", () => {
    // peaked +50%, pulled back to +40% ≤ 0.50-0.08=0.42 → trail (locks +40%, beats the +35% TP).
    assert.equal(decidePaperExit(0.4, 0.5, 1000, P), "trail");
  });

  it("trails: armed at +20% peak, exits when it falls 8% below peak", () => {
    assert.equal(decidePaperExit(0.11, 0.2, 1000, P), "trail");
  });

  it("does NOT trail while still near the peak", () => {
    assert.equal(decidePaperExit(0.16, 0.2, 1000, P), null);
  });

  it("does NOT trail before arming (peak below arm)", () => {
    assert.equal(decidePaperExit(-0.05, 0.1, 1000, P), null);
  });

  it("times out after max hold", () => {
    assert.equal(decidePaperExit(0.02, 0.05, 36 * 60_000, P), "timeout");
  });

  it("stagnation cut: never armed the trail → cut early to free capital", () => {
    const withStag = { ...P, stagnationMs: 10 * 60_000 };
    // peak only +5% (< arm 0.15) at 11min → stagnation timeout.
    assert.equal(decidePaperExit(0.03, 0.05, 11 * 60_000, withStag), "timeout");
    // a mover that armed the trail is NOT stagnation-cut.
    assert.equal(decidePaperExit(0.18, 0.2, 11 * 60_000, withStag), null);
  });

  it("holds when nothing is triggered", () => {
    assert.equal(decidePaperExit(0.05, 0.06, 1000, P), null);
  });

  it("trailing disabled (arm/stop 0): the fixed take-profit applies", () => {
    const noTrail = { ...P, trailArmPct: 0, trailStopPct: 0 };
    assert.equal(decidePaperExit(0.4, 0.4, 1000, noTrail), "tp");
    assert.equal(decidePaperExit(0.11, 0.2, 1000, noTrail), null);
  });

  // T3.3 — genesis exit: wide SL only, no TP / trail / stagnation. The backtest
  // proved tail-clipping exits destroy total return, so a genesis winner must
  // NEVER be capped — only a catastrophic rug-cut or max-hold closes it.
  const GENESIS = {
    tpPct: Number.POSITIVE_INFINITY,
    slPct: 0.40,
    maxHoldMs: 5 * 60_000,
    trailArmPct: 0,
    trailStopPct: 0,
    stagnationMs: 0,
  };

  it("genesis: a +500% moon is NEVER capped (no TP, no trail)", () => {
    assert.equal(decidePaperExit(5.0, 5.0, 1000, GENESIS), null);
    assert.equal(decidePaperExit(2.0, 8.0, 1000, GENESIS), null); // pulled back from +800% but still held
  });

  it("genesis: rug-cut fires only at the wide catastrophic SL", () => {
    assert.equal(decidePaperExit(-0.30, 0.1, 1000, GENESIS), null); // -30% not cut (wide floor)
    assert.equal(decidePaperExit(-0.41, 0.1, 1000, GENESIS), "sl"); // past -40% → cut
  });

  it("genesis: no stagnation cut — a flat coin holds to max-hold", () => {
    assert.equal(decidePaperExit(0.02, 0.05, 2 * 60_000, GENESIS), null); // 2min, flat → still held
    assert.equal(decidePaperExit(0.02, 0.05, 5 * 60_000, GENESIS), "timeout"); // max-hold reached
  });

  // The auto-trader derives peak as Math.max(prevPeak, pctOfSize) (auto-trader.ts:544),
  // so peak >= current ALWAYS. With trailing enabled and trailArmPct <= tpPct, reaching
  // tpPct necessarily arms the trail first, which makes the fixed-TP branch unreachable.
  // DEFAULT_PARAMS ships trailingArmPct 0.15 / trailingStopPct 0.08 and both start routes
  // spread it, so this is the live configuration. Pinned so a future change to the
  // defaults (or to the peak formula) fails loudly instead of silently re-enabling "tp".
  it("production config: reaching tpPct always arms the trail first, so 'tp' cannot fire", () => {
    assert.equal(decidePaperExit(0.35, 0.35, 1000, P), null);
    assert.equal(decidePaperExit(0.4, 0.4, 1000, P), null);
  });

  it("fixed TP fires only when the trail arms ABOVE the take-profit", () => {
    const lateArm = { ...P, trailArmPct: 0.5 }; // arm 0.50 > tp 0.35
    assert.equal(decidePaperExit(0.35, 0.35, 1000, lateArm), "tp");
  });

  it("hard stop wins over an armed trail on the same tick", () => {
    assert.equal(decidePaperExit(-0.13, 0.5, 1000, P), "sl");
  });

  it("thresholds are inclusive at the boundary", () => {
    assert.equal(decidePaperExit(-0.12, 0.05, 1000, P), "sl"); // exactly -slPct
    assert.equal(decidePaperExit(0.12, 0.2, 1000, P), "trail"); // exactly peak - trailStopPct
    assert.equal(decidePaperExit(0.02, 0.05, 35 * 60_000, P), "timeout"); // exactly maxHoldMs
  });

  it("stagnation is suppressed when stagnationMs is absent or 0", () => {
    assert.equal(decidePaperExit(0.03, 0.05, 11 * 60_000, P), null);
    assert.equal(decidePaperExit(0.03, 0.05, 11 * 60_000, { ...P, stagnationMs: 0 }), null);
  });
});
