/** Max token lifetime used for timing gate (6h — matches demo relax P75). */
export const TIMING_GATE_MAX_AGE_SEC = 21_600;

export function decisionAgeSeconds(decisionTs: string | Date): number {
  const t =
    decisionTs instanceof Date ? decisionTs.getTime() : new Date(decisionTs).getTime();
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, (Date.now() - t) / 1000);
}

/**
 * Prefer recent on-chain activity; when the token row is months old (continuation),
 * use age since the BUY decision instead of lifetime.
 */
export function resolveTimingAgeSeconds(
  flowAge: number | null | undefined,
  decisionTs: string | Date,
  maxTokenAgeSec = TIMING_GATE_MAX_AGE_SEC,
): number {
  const decisionAge = decisionAgeSeconds(decisionTs);
  if (flowAge == null || !Number.isFinite(flowAge) || flowAge < 0) return decisionAge;
  if (flowAge > maxTokenAgeSec) return decisionAge;
  return Math.min(flowAge, decisionAge);
}

/** Pick a plausible flow age from SQL probes (recent activity before token.created_at). */
export function coalesceFlowAgeSeconds(row: {
  token_age: number | null;
  trend_age: number | null;
  first_event_age: number | null;
  last_snapshot_age: number | null;
}): number | null {
  const ordered = [
    row.first_event_age,
    row.last_snapshot_age,
    row.trend_age,
    row.token_age,
  ];
  for (const a of ordered) {
    if (a != null && Number.isFinite(a) && a >= 0 && a <= TIMING_GATE_MAX_AGE_SEC) return a;
  }
  return null;
}
