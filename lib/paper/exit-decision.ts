/**
 * Pure exit-decision logic (no server-only — testable).
 *
 * Priority order: take-profit (full target) → trailing stop (lock gains once
 * armed) → stop-loss → max-hold timeout. Extracted from the auto-trader so the
 * trailing/curve logic is deterministically testable (L4).
 */
export type ExitReason = "tp" | "trail" | "sl" | "timeout" | null;

export type ExitDecisionParams = {
  tpPct: number;
  slPct: number;
  maxHoldMs: number;
  /** 0 disables trailing. */
  trailArmPct: number;
  trailStopPct: number;
};

export function decidePaperExit(
  pctOfSize: number,
  peakPct: number,
  ageMs: number,
  p: ExitDecisionParams,
): ExitReason {
  const trailingEnabled = p.trailArmPct > 0 && p.trailStopPct > 0;
  const trailingArmed = trailingEnabled && peakPct >= p.trailArmPct;

  if (pctOfSize >= p.tpPct) return "tp";
  if (trailingArmed && pctOfSize <= peakPct - p.trailStopPct) return "trail";
  if (pctOfSize <= -p.slPct) return "sl";
  if (ageMs >= p.maxHoldMs) return "timeout";
  return null;
}
