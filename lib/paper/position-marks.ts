/**
 * Sampling policy for position marks (pure, testable).
 *
 * handleExits runs every 3s over every open position. Writing a mark per tick
 * would be ~17 rows/s at 50 positions for no extra information -- the pump.fun
 * price behind it is itself cached for 8s. 30s is the resolution an exit-policy
 * replay needs (the shortest rule under consideration cuts at 5 min = 10 marks)
 * and keeps the write rate under ~2 rows/s at the concurrency ceiling.
 */
export const MARK_INTERVAL_MS = 30_000;

/**
 * True when this position is due for a mark. A never-marked position (null)
 * is always due, so every position gets a t=0 sample the first tick it is seen.
 */
export function shouldMark(
  lastMarkAtMs: number | null | undefined,
  nowMs: number,
  intervalMs: number = MARK_INTERVAL_MS,
): boolean {
  if (lastMarkAtMs == null || !Number.isFinite(lastMarkAtMs)) return true;
  return nowMs - lastMarkAtMs >= intervalMs;
}

/** Seconds since an ISO timestamp; null when absent or unparseable. */
export function ageSeconds(iso: string | null | undefined, nowMs: number): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round((nowMs - t) / 1000));
}
