/**
 * Auto-trade entry capacity (PURE — no server-only, testable).
 *
 * Upgrade-plan Phase 0, issue #11. A paper auto-session must respect BOTH:
 *   - its own concurrency cap (session.params.maxConcurrent), counting only the
 *     positions IT owns (entry_features.session_id), and
 *   - the GLOBAL paper-ledger cap (the kernel's maxOpenPositions), counting EVERY
 *     open position — including ones orphaned by a stopped session.
 *
 * Counting only the session's own positions makes the auto-trader attempt opens
 * the kernel will reject whenever orphans hold the global cap. Bounding by both
 * makes capacity honest (and is conservative — it can only reduce attempts, never
 * open more than before).
 */
export function entryHeadroom(i: {
  /** This session's own concurrency cap. */
  sessionMaxConcurrent: number;
  /** OPEN positions owned by this session. */
  ownedByActive: number;
  /** Global paper-ledger cap (kernel maxOpenPositions). */
  globalCap: number;
  /** Every OPEN paper position (orphans included). */
  totalOpen: number;
  /** Apply the global cap? False for live sessions (the paper ledger doesn't gate live). */
  applyGlobalCap: boolean;
}): number {
  const sessionHeadroom = i.sessionMaxConcurrent - i.ownedByActive;
  if (!i.applyGlobalCap) return Math.max(0, sessionHeadroom);
  const globalHeadroom = i.globalCap - i.totalOpen;
  return Math.max(0, Math.min(sessionHeadroom, globalHeadroom));
}
