import "server-only";

export type IngestorConnState = "idle" | "connecting" | "open" | "subscribed" | "closed" | "error";

export type IngestorStats = {
  startedAt: number;
  endpoint: string | null;
  connState: IngestorConnState;
  connectedAt: number | null;
  lastMessageAt: number | null;
  reconnects: number;
  signaturesSeen: number;
  eventsParsed: number;
  eventsInserted: number;
  decodeErrors: number;
  /** Events dropped because the ingest buffer hit MAX_INGEST_QUEUE. Silent data
   *  loss until now: this was a closure-local counter the diagnostics endpoints
   *  could not see, so a slow Postgres shed events invisibly. */
  eventsDropped: number;
  /**
   * When the most recent drop happened. eventsDropped is cumulative and never
   * resets, so it cannot answer "is the feed shedding data NOW" — asking that
   * of the counter turned one old blip into a permanent trading stop (H09).
   */
  lastDropAt: number | null;
  /** received -> decoded: Borsh decode cost in the WS callback (ms). */
  decodeMsLast: number;
  decodeMsMax: number;
  /** decoded -> persisted: full flush chain duration (ms). Rising values here are
   *  what push the buffer toward MAX_INGEST_QUEUE and cause silent drops. */
  flushMsLast: number;
  flushMsMax: number;
  flushes: number;
  /** High-water mark of the in-memory buffer vs MAX_INGEST_QUEUE. */
  bufferDepthMax: number;
  bufferCapacity: number;
  lastError: string | null;
  bySecond: number[];
};

const BUCKETS = 60;

declare global {
  // eslint-disable-next-line no-var
  var __spr_ingestor_stats__: IngestorStats | undefined;
}

export function getIngestorStats(): IngestorStats {
  if (!globalThis.__spr_ingestor_stats__) {
    globalThis.__spr_ingestor_stats__ = {
      startedAt: Date.now(),
      endpoint: null,
      connState: "idle",
      connectedAt: null,
      lastMessageAt: null,
      reconnects: 0,
      signaturesSeen: 0,
      eventsParsed: 0,
      eventsInserted: 0,
      decodeErrors: 0,
      eventsDropped: 0,
      lastDropAt: null,
      decodeMsLast: 0,
      decodeMsMax: 0,
      flushMsLast: 0,
      flushMsMax: 0,
      flushes: 0,
      bufferDepthMax: 0,
      bufferCapacity: 0,
      lastError: null,
      bySecond: new Array(BUCKETS).fill(0),
    };
  }
  return globalThis.__spr_ingestor_stats__;
}

export function recordSignature(now: number = Date.now()) {
  const s = getIngestorStats();
  s.signaturesSeen++;
  s.lastMessageAt = now;
  const bucket = Math.floor(now / 1000) % BUCKETS;
  s.bySecond[bucket]++;
}

export function decayBuckets(now: number = Date.now()) {
  const s = getIngestorStats();
  const next = (Math.floor(now / 1000) + 1) % BUCKETS;
  s.bySecond[next] = 0;
}

export function sigsLastMinute(): number {
  const s = getIngestorStats();
  return s.bySecond.reduce((a, b) => a + b, 0);
}
