import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CURVE_DIV,
  mcapUsdFromVSolAt,
  effectiveVSolFromMcapUsdAt,
  paperPnlSol,
  pnlFromMcap,
  markPnl,
} from "@/lib/pricing/seam";

const FEES = { pumpFeesPct: 0.01, paperSlippagePct: 0.01 };
const close = (a: number, b: number, eps = 1e-9) =>
  Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b));

describe("pricing seam — round-trip identity (invariant 2)", () => {
  it("effectiveVSolFromMcapUsdAt is the exact inverse of mcapUsdFromVSolAt at any rate", () => {
    for (const solUsd of [12, 67, 150, 230, 312.5]) {
      for (const vSol of [1, 5, 30, 85, 420.69]) {
        const mcap = mcapUsdFromVSolAt(vSol, solUsd)!;
        const back = effectiveVSolFromMcapUsdAt(mcap, solUsd)!;
        assert.ok(close(back, vSol), `rate=${solUsd} vSol=${vSol} → ${back}`);
      }
    }
  });

  it("mcap scales linearly with the SOL rate and quadratically with vSol", () => {
    assert.ok(close(mcapUsdFromVSolAt(10, 100)!, 2 * mcapUsdFromVSolAt(10, 50)!));
    assert.ok(close(mcapUsdFromVSolAt(20, 67)!, 4 * mcapUsdFromVSolAt(10, 67)!));
    assert.equal(mcapUsdFromVSolAt(85, 67), ((85 * 85) / CURVE_DIV) * 67);
  });

  it("guards reject non-positive / non-finite inputs", () => {
    assert.equal(mcapUsdFromVSolAt(0, 67), null);
    assert.equal(mcapUsdFromVSolAt(10, 0), null);
    assert.equal(effectiveVSolFromMcapUsdAt(null, 67), null);
    assert.equal(effectiveVSolFromMcapUsdAt(1000, 0), null);
  });
});

describe("pricing seam — PnL is SOL-price independent (invariant 1, the 2.24× bug class)", () => {
  it("curve-model pctOfSize is identical regardless of the SOL/USD rate", () => {
    // Build entry+current vSol from a fixed economic state, then mark via the
    // curve model. The ratio (cur/entry)² carries no SOL price → must be invariant.
    const entryVSol = 40;
    const currentVSol = 52; // +30% on vSol
    const base = paperPnlSol({ sizeSol: 0.05, entryVSol, currentVSol, ...FEES }).pctOfSize;
    for (const solUsd of [67, 150, 230]) {
      // mcap derived at this rate, then converted back — the vSol is unchanged,
      // so PnL must match `base` exactly for every rate.
      const eMcap = mcapUsdFromVSolAt(entryVSol, solUsd)!;
      const cMcap = mcapUsdFromVSolAt(currentVSol, solUsd)!;
      const effEntry = effectiveVSolFromMcapUsdAt(eMcap, solUsd)!;
      const effCur = effectiveVSolFromMcapUsdAt(cMcap, solUsd)!;
      const pct = paperPnlSol({ sizeSol: 0.05, entryVSol: effEntry, currentVSol: effCur, ...FEES }).pctOfSize;
      assert.ok(close(pct, base), `rate=${solUsd}: ${pct} vs ${base}`);
    }
  });

  it("mcap-model pctOfSize is identical regardless of the SOL/USD rate", () => {
    // pnlFromMcap uses currentMcap/entryMcap; the rate cancels in the ratio.
    const entryVSol = 40;
    const currentVSol = 52;
    const ref = pnlFromMcap({
      sizeSol: 0.05,
      entryMcapUsd: mcapUsdFromVSolAt(entryVSol, 67)!,
      currentMcapUsd: mcapUsdFromVSolAt(currentVSol, 67)!,
      ...FEES,
    }).pctOfSize;
    for (const solUsd of [12, 150, 230]) {
      const pct = pnlFromMcap({
        sizeSol: 0.05,
        entryMcapUsd: mcapUsdFromVSolAt(entryVSol, solUsd)!,
        currentMcapUsd: mcapUsdFromVSolAt(currentVSol, solUsd)!,
        ...FEES,
      }).pctOfSize;
      assert.ok(close(pct, ref), `rate=${solUsd}: ${pct} vs ${ref}`);
    }
  });
});

describe("pricing seam — curve and mcap models agree where both apply (invariant)", () => {
  it("pnlFromMcap == paperPnlSol when the mcaps are the curve images of the vSols", () => {
    const solUsd = 67;
    for (const [entryVSol, currentVSol] of [
      [40, 52],
      [30, 30],
      [85, 60],
      [10, 25],
    ] as const) {
      const curve = paperPnlSol({ sizeSol: 0.05, entryVSol, currentVSol, ...FEES });
      const mcap = pnlFromMcap({
        sizeSol: 0.05,
        entryMcapUsd: mcapUsdFromVSolAt(entryVSol, solUsd)!,
        currentMcapUsd: mcapUsdFromVSolAt(currentVSol, solUsd)!,
        ...FEES,
      });
      // mcap ratio = (cur²)/(entry²) = (cur/entry)² = curve raw ratio, and both
      // apply the same friction² haircut → identical pctOfSize and pnlSol.
      assert.ok(close(mcap.pctOfSize, curve.pctOfSize), `pct ${mcap.pctOfSize} vs ${curve.pctOfSize}`);
      assert.ok(close(mcap.pnlSol, curve.pnlSol), `pnl ${mcap.pnlSol} vs ${curve.pnlSol}`);
    }
  });
});

describe("markPnl — graduation continuity (invariant 3, the 5× frozen-vSol bug class)", () => {
  it("picks the mcap model when entry mcap is real and books entry·√ratio", () => {
    const r = markPnl({
      sizeSol: 0.05,
      entryVSol: 40,
      currentVSol: 40, // frozen post-graduation value — must NOT be used
      entryMcapUsd: 16_000,
      currentMcapUsd: 80_000, // real 5× move the frozen vSol would have hidden
      entryMcapReal: true,
      graduated: true,
      ...FEES,
    });
    assert.equal(r.model, "mcap");
    // booking price reproduces the mcap ratio when squared
    assert.ok(close((r.realizedExitVSol! / 40) ** 2, 80_000 / 16_000, 1e-9));
    assert.ok(r.pctOfSize > 3.5, `expected ~+4x, got ${r.pctOfSize}`);
  });

  it("an unchanged economic state reads ~0% via EITHER model (continuity at the boundary)", () => {
    const onCurve = markPnl({
      sizeSol: 0.05,
      entryVSol: 50,
      currentVSol: 50,
      graduated: false,
      ...FEES,
    });
    const justGraduated = markPnl({
      sizeSol: 0.05,
      entryVSol: 50,
      currentVSol: null, // curve feed frozen
      entryMcapUsd: 25_000,
      currentMcapUsd: 25_000, // same economic state, now from DEX mcap
      entryMcapReal: true,
      graduated: true,
      ...FEES,
    });
    // Same friction haircut on both sides → both are the small negative fee drag,
    // and they must agree (no discontinuity when the price source flips).
    assert.ok(close(onCurve.pctOfSize, justGraduated.pctOfSize, 1e-9));
  });

  it("falls back to the curve model when entry mcap is not real, and overrides only post-graduation", () => {
    const pre = markPnl({ sizeSol: 0.05, entryVSol: 40, currentVSol: 48, graduated: false, ...FEES });
    assert.equal(pre.model, "curve");
    assert.equal(pre.realizedExitVSol, null); // pre-graduation: no override, resolver picks

    const post = markPnl({ sizeSol: 0.05, entryVSol: 40, currentVSol: 48, graduated: true, ...FEES });
    assert.equal(post.realizedExitVSol, 48); // post-graduation: book at the effective vSol

    const noPrice = markPnl({ sizeSol: 0.05, entryVSol: 40, currentVSol: null, graduated: false, ...FEES });
    assert.equal(noPrice.pnlSol, 0);
    assert.equal(noPrice.realizedExitVSol, null);
  });

  it("does NOT use the mcap model when the entry mcap is only an estimate", () => {
    const r = markPnl({
      sizeSol: 0.05,
      entryVSol: 40,
      currentVSol: 52,
      entryMcapUsd: 16_000,
      currentMcapUsd: 80_000,
      entryMcapReal: false, // estimate only → must fall back to the curve vSol
      graduated: true,
      ...FEES,
    });
    assert.equal(r.model, "curve");
  });
});
