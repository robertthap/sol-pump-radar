import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildWorkerIngestStats, INGEST_SNAPSHOT_STALE_MS } from "@/lib/runtime/worker-ingest-stats";

/**
 * The web tier must never present its own zeroes as worker state. These pin the
 * fail-closed contract: unknown => nulls + an explicit state, never "idle, 0".
 */
const INGEST = { connState: "subscribed", signaturesSeen: 141422, eventsDropped: 0 };
const row = (ageMs: number | string, ingest: Record<string, unknown> | null = INGEST) => ({
  captured_at: "2026-09-04T00:30:00.000Z",
  age_ms: ageMs,
  ingest,
});

describe("buildWorkerIngestStats", () => {
  it("reports published worker counters when the snapshot is fresh", () => {
    const s = buildWorkerIngestStats(row(5_000));
    assert.equal(s.workerState, "live");
    assert.equal(s.ageSec, 5);
    assert.deepEqual(s.ingest, INGEST);
  });

  it("withholds counters once the snapshot is stale", () => {
    const s = buildWorkerIngestStats(row(INGEST_SNAPSHOT_STALE_MS + 1));
    assert.equal(s.workerState, "stale");
    assert.equal(s.ingest, null, "stale counters are history, not current state");
  });

  it("treats the staleness boundary as inclusive", () => {
    assert.equal(buildWorkerIngestStats(row(INGEST_SNAPSHOT_STALE_MS)).workerState, "live");
  });

  it("reports unavailable when no snapshot exists", () => {
    assert.deepEqual(buildWorkerIngestStats(null), {
      workerState: "unavailable", ageSec: null, capturedAt: null, ingest: null,
    });
  });

  it("reports unavailable when the payload carries no ingest block", () => {
    assert.equal(buildWorkerIngestStats(row(1_000, null)).workerState, "unavailable");
  });

  it("fails closed on an unreadable age rather than claiming live", () => {
    assert.equal(buildWorkerIngestStats(row("not-a-number")).workerState, "unavailable");
  });

  it("accepts a numeric-string age from Postgres", () => {
    const s = buildWorkerIngestStats(row("4000"));
    assert.equal(s.workerState, "live");
    assert.equal(s.ageSec, 4);
  });

  it("never yields a zeroed counter set for an absent worker", () => {
    for (const r of [null, row(999_999), row(1_000, null)]) {
      const s = buildWorkerIngestStats(r);
      if (s.workerState !== "live") assert.equal(s.ingest, null);
    }
  });
});
