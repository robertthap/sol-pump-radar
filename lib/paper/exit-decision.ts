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
  /** Cut a position that never built momentum by this age, to free capital from
   *  slow movers. 0/undefined disables. */
  stagnationMs?: number;
  /** Peak ceiling for the stagnation cut: only cut if the position's peak stayed
   *  BELOW this. Defaults to `trailArmPct` (the historical "never armed the
   *  trail" rule) so omitting it reproduces the previous behaviour exactly. */
  stagnationMaxPeakPct?: number;
};

export function decidePaperExit(
  pctOfSize: number,
  peakPct: number,
  ageMs: number,
  p: ExitDecisionParams,
): ExitReason {
  const trailingEnabled = p.trailArmPct > 0 && p.trailStopPct > 0;
  const trailingArmed = trailingEnabled && peakPct >= p.trailArmPct;
  // The stagnation ceiling is independent of the trail so a fast-turnover
  // preset can cut at "never beat +3%" while still arming its trail at +6%.
  const stagnationCeiling = p.stagnationMaxPeakPct ?? p.trailArmPct;

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
    if (
      p.stagnationMs &&
      p.stagnationMs > 0 &&
      ageMs >= p.stagnationMs &&
      peakPct < stagnationCeiling
    )
      return "stagnation";
  }

  if (ageMs >= p.maxHoldMs) return "timeout";
  return null;
}
