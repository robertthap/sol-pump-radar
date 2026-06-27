/**
 * Canonical pricing & PnL seam (PURE — no server-only, no DB/IO; fully testable).
 *
 * Phase 0 of the upgrade plan (docs/SYSTEM_DESIGN.md §Part II). This is the ONE
 * place that owns the on-curve ↔ post-graduation price/PnL decision, with its
 * invariants locked by lib/pricing/seam.test.ts. It exists to permanently close
 * the bug class that produced the historical mismarks:
 *   - 2.24× : an absolute mcap computed with the stale getSolUsdSync() fallback.
 *   - 5×    : marking a graduated position against the frozen events.v_sol_after.
 *
 * INVARIANTS (asserted in the tests):
 *   1. PnL is RATIO-based, so pctOfSize is INDEPENDENT of the SOL/USD rate. A wrong
 *      SOL price can only skew an absolute mcap *display*, never realized/booked PnL.
 *   2. mcapUsdFromVSolAt and effectiveVSolFromMcapUsdAt are exact inverses at any
 *      fixed SOL price (round-trip identity).
 *   3. PnL is CONTINUOUS across the graduation boundary: the same economic state
 *      marked via the curve-vSol model or the real-mcap model yields the same
 *      pctOfSize.
 */
import {
  CURVE_DIV,
  mcapUsdFromVSol,
  mcapUsdFromVSolAt,
  effectiveVSolFromMcapUsd,
  effectiveVSolFromMcapUsdAt,
} from "@/lib/dex/curve-mcap";
import { paperPnlSol } from "@/lib/paper/math";
import { pnlFromMcap } from "@/lib/paper/mcap-pnl";

// Re-export the canonical pure building blocks so callers import the math from a
// single surface ("the seam") rather than three scattered modules.
export {
  CURVE_DIV,
  mcapUsdFromVSol,
  mcapUsdFromVSolAt,
  effectiveVSolFromMcapUsd,
  effectiveVSolFromMcapUsdAt,
  paperPnlSol,
  pnlFromMcap,
};

export type PnlModel = "mcap" | "curve";

export type MarkInput = {
  sizeSol: number;
  /** Entry virtual SOL (bonding-curve units). */
  entryVSol: number;
  /** Live curve / effective vSol now; null when no live feed is available. */
  currentVSol: number | null;
  /** Real entry market cap (USD) if known and trustworthy. */
  entryMcapUsd?: number | null;
  /** Live market cap (USD) if known. */
  currentMcapUsd?: number | null;
  /** Only true when the entry mcap is a REAL observed value (not a curve estimate). */
  entryMcapReal?: boolean;
  /** Whether the coin has graduated off the bonding curve. */
  graduated?: boolean;
  pumpFeesPct: number;
  paperSlippagePct: number;
};

export type MarkResult = {
  pnlSol: number;
  pctOfSize: number;
  model: PnlModel;
  /**
   * vSol to book the close at so the bonding-curve close (value ∝ vSol²) matches
   * the chosen PnL model. `null` = let the resolver pick the live price (curve,
   * pre-graduation) — the caller should treat this as "no override".
   */
  realizedExitVSol: number | null;
};

/**
 * The single mark-to-PnL decision, extracted verbatim from the auto-trader's exit
 * path so paper and any other consumer share ONE implementation:
 *
 *   - Prefer the REAL-mcap model when we have a real entry mcap and a live current
 *     mcap (accurate on AND off the curve). Book the close at entry·√(mcapNow/mcapEntry)
 *     so the quadratic curve close reproduces the same ratio.
 *   - Otherwise fall back to the bonding-curve vSol model. Pre-graduation the live
 *     curve feed is authoritative (no override); post-graduation we hand back the
 *     graduation-derived effective vSol as the booking price.
 */
export function markPnl(i: MarkInput): MarkResult {
  const useRealMcap =
    i.entryMcapReal === true &&
    i.entryMcapUsd != null &&
    i.entryMcapUsd > 0 &&
    i.currentMcapUsd != null &&
    i.currentMcapUsd > 0;

  if (useRealMcap) {
    const r = pnlFromMcap({
      sizeSol: i.sizeSol,
      entryMcapUsd: i.entryMcapUsd!,
      currentMcapUsd: i.currentMcapUsd!,
      pumpFeesPct: i.pumpFeesPct,
      paperSlippagePct: i.paperSlippagePct,
    });
    const realizedExitVSol = i.entryVSol * Math.sqrt(i.currentMcapUsd! / i.entryMcapUsd!);
    return { pnlSol: r.pnlSol, pctOfSize: r.pctOfSize, model: "mcap", realizedExitVSol };
  }

  if (i.currentVSol == null) {
    return { pnlSol: 0, pctOfSize: 0, model: "curve", realizedExitVSol: null };
  }

  const r = paperPnlSol({
    sizeSol: i.sizeSol,
    entryVSol: i.entryVSol,
    currentVSol: i.currentVSol,
    pumpFeesPct: i.pumpFeesPct,
    paperSlippagePct: i.paperSlippagePct,
  });
  const realizedExitVSol = i.graduated ? i.currentVSol : null;
  return { pnlSol: r.pnlSol, pctOfSize: r.pctOfSize, model: "curve", realizedExitVSol };
}
