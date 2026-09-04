/**
 * Worker ingest-stat freshness (no server-only — testable).
 *
 * The ingestor runs in the worker process; getIngestorStats() is a per-process
 * global. The web tier therefore cannot read it and previously served its own
 * untouched zeroes as if they were worker state. The worker instead publishes
 * counters into runtime_snapshots and the web tier classifies their freshness
 * here — failing CLOSED, so a stopped worker never looks like an idle one.
 */

/** The worker publishes every 30s; three missed intervals means unknown. */
export const INGEST_SNAPSHOT_STALE_MS = 90_000;

export type WorkerIngestStats = {
  /** "live" | "stale" | "unavailable" — never silently 0. */
  workerState: "live" | "stale" | "unavailable";
  ageSec: number | null;
  capturedAt: string | null;
  ingest: Record<string, unknown> | null;
};

export type RuntimeSnapshotIngestRow = {
  captured_at: string;
  /** Postgres may return this as a numeric string. */
  age_ms: string | number;
  ingest: Record<string, unknown> | null;
};

export function buildWorkerIngestStats(
  row: RuntimeSnapshotIngestRow | null | undefined,
  staleMs: number = INGEST_SNAPSHOT_STALE_MS,
): WorkerIngestStats {
  if (!row || !row.ingest) {
    return { workerState: "unavailable", ageSec: null, capturedAt: null, ingest: null };
  }
  const ageMs = Number(row.age_ms);
  if (!Number.isFinite(ageMs)) {
    // Unreadable age: refuse to claim the worker is live.
    return { workerState: "unavailable", ageSec: null, capturedAt: row.captured_at, ingest: null };
  }
  const fresh = ageMs <= staleMs;
  return {
    workerState: fresh ? "live" : "stale",
    ageSec: Math.round(ageMs / 1000),
    capturedAt: row.captured_at,
    // Stale counters are frozen history, not current state — withhold them.
    ingest: fresh ? row.ingest : null,
  };
}
