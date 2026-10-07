/**
 * Is the ingest feed healthy enough to open a NEW position? (H09) — PURE.
 *
 * The first version of this asked `stats.eventsDropped > 0`. That counter is
 * CUMULATIVE for the life of the worker process and never resets, so a single
 * shed event — one RPC hiccup, hours ago — permanently refused every entry
 * until someone restarted the worker. The bot would trade normally, drop one
 * event, and then silently never trade again.
 *
 * That is worse than the problem it was guarding: a transient feed blip became
 * an indefinite trading stop with no message saying so.
 *
 * Health is a question about NOW. A drop that has stopped happening is history;
 * a drop still happening means the book really is incomplete.
 */

/** A drop this recent means the feed is still shedding data right now. */
export const DROP_DEGRADED_MS = 30_000;

export type FeedSnapshot = {
  connState: string;
  /** Cumulative drops. Only used via lastDropAt — never compared to zero. */
  eventsDropped: number;
  /** When the most recent drop happened, or null if none this process. */
  lastDropAt: number | null;
};

export function feedDegraded(snapshot: FeedSnapshot, now: number): boolean {
  const connected = snapshot.connState === "subscribed" || snapshot.connState === "open";
  if (!connected) return true;
  if (snapshot.lastDropAt == null) return false;
  return now - snapshot.lastDropAt < DROP_DEGRADED_MS;
}
