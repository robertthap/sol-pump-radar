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
