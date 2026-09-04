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
 *
 * SEMANTICS — READ BEFORE USING THIS AS A LATENCY METRIC.
 * The result is `min(flowAge, decisionAge)`, and it DEGRADES TO `decisionAge`
 * (i.e. pending-queue wait, not token age) whenever flow age is unavailable or
 * exceeds `maxTokenAgeSec`. So the value it feeds — `entry_features.
 * entry_age_seconds` — is a BLEND: token age for fresh launches, queue wait for
 * anything older than the gate. Observed live: rows with a 175s-old token
 * reported 7.4s here, because the token exceeded the gate and the queue wait was
 * 7.4s.
 *
 * It is therefore NOT a clean "reaction latency". Use
 * `entry_features.decision_to_intent_ms` for unambiguous decision->execution
 * queue latency. This field is retained for the timing gate and for historical
 * comparability.
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
