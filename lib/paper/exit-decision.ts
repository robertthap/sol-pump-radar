/**
 * Pure exit-decision logic (no server-only — testable).
 *
 * Priority: stop-loss → (once the trail is ARMED) trailing stop → otherwise a
 * fixed take-profit for small winners → stagnation cut → max-hold timeout.
 *
 * "Let winners run": the fixed take-profit only applies to positions that never
 * armed the trailing stop. Once a position runs up past `trailArmPct` it is a
 * real mover — we DROP the fixed TP and let the trailing stop ride the move, so a
 * strong runner is captured near its peak instead of being capped at `tpPct`.
 */
export type ExitReason = "tp" | "trail" | "sl" | "stagnation" | "timeout" | null;

export type ExitDecisionParams = {
  tpPct: number;
  slPct: number;
  maxHoldMs: number;
  /** 0 disables trailing. */
  trailArmPct: number;
  trailStopPct: number;
  /** Cut a position that never built momentum (never armed the trail) by this age,
   *  to free capital from slow movers. 0/undefined disables. */
  stagnationMs?: number;
};

export function decidePaperExit(
  pctOfSize: number,
  peakPct: number,
  ageMs: number,
  p: ExitDecisionParams,
): ExitReason {
  const trailingEnabled = p.trailArmPct > 0 && p.trailStopPct > 0;
  const trailingArmed = trailingEnabled && peakPct >= p.trailArmPct;

  // Hard stop always wins.
  if (pctOfSize <= -p.slPct) return "sl";

  if (trailingArmed) {
    // Let winners run: no fixed TP cap — exit only when price falls trailStopPct
    // below the peak.
    if (pctOfSize <= peakPct - p.trailStopPct) return "trail";
  } else {
    // Small winner that never armed the trail: take the fixed profit.
    if (pctOfSize >= p.tpPct) return "tp";
    // Stagnation cut: built no momentum → free the slot well before max-hold.
    // Distinct from "timeout" so the ledger can tell a flat-position cut from a
    // genuine max-hold expiry — they had the same reason string before, which
    // made the cut invisible in every report.
    if (p.stagnationMs && p.stagnationMs > 0 && ageMs >= p.stagnationMs) return "stagnation";
  }

  if (ageMs >= p.maxHoldMs) return "timeout";
  return null;
}
