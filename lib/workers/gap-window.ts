/**
 * Gap window arithmetic for ingest restarts and reconnects (H05) — PURE, no IO.
 *
 * Two holes this closes.
 *
 * RESTART. `getWatermark()` existed, was documented as the thing that lets "a
 * worker restart inherit the watermark from the DB", and was never called by
 * anything. The ingestor started with hwmSlot = 0n every time, so the span
 * between shutdown and startup produced NO gap: whatever happened while the
 * worker was down was never recovered and never recorded as missing. A crash
 * loop therefore loses data silently, repeatedly.
 *
 * DOUBLE DISCONNECT. The reconnect handler logged "coalescing into one gap" and
 * returned. Nothing coalesced. The first recovery covers [A,B]; a disconnect
 * during it opens [C,D], which was dropped on the floor. The word in the log
 * described an intention the code did not implement.
 */

export type GapWindow = { fromSlot: bigint; fromTs: Date };

/**
 * Merge a disconnect that arrived while a recovery was already running.
 *
 * The EARLIEST start wins, because a gap that begins earlier strictly contains
 * more missing data; the recovery walks forward to the current head either way.
 * This is what "coalescing" has to mean to be true.
 */
export function coalesceWindow(pending: GapWindow | null, incoming: GapWindow): GapWindow {
  if (!pending) return incoming;
  return incoming.fromSlot < pending.fromSlot ? incoming : pending;
}

export type PersistedWatermark = { lastSlot: bigint; lastTs: Date } | null;

/**
 * The gap a STARTUP implies, from the watermark the last run persisted.
 *
 * Returns null when there is nothing to recover: no watermark at all (a fresh
 * database — there is no "before" to miss), or a slot of zero.
 *
 * `maxRecoverableSec` matches the reconnect path's cap: a worker that was down
 * for days must not try to walk the whole interval, but the window is still
 * REPORTED so the downtime is recorded rather than forgotten.
 */
export function startupWindow(
  persisted: PersistedWatermark,
  now: Date,
  maxRecoverableSec: number,
): { window: GapWindow; downtimeSec: number; recoverable: boolean } | null {
  if (!persisted || persisted.lastSlot <= 0n) return null;
  const downtimeSec = Math.max(0, (now.getTime() - persisted.lastTs.getTime()) / 1000);
  return {
    window: { fromSlot: persisted.lastSlot, fromTs: persisted.lastTs },
    downtimeSec,
    recoverable: downtimeSec <= maxRecoverableSec,
  };
}
