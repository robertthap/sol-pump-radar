import { NextResponse } from "next/server";
import { bootDb } from "@/lib/db/client";
import { countSinceBoot } from "@/lib/db/repos/events";
import { cached } from "@/lib/api/short-cache";
import { fetchWorkerIngestStats } from "@/lib/runtime/health-read";

export const dynamic = "force-dynamic";

/**
 * Ingestion health.
 *
 * The ingestor runs in the WORKER process. This route runs in the web process,
 * so it cannot read getIngestorStats() — that is a per-process global and would
 * report the web tier's own untouched zeroes (connState "idle", signaturesSeen 0,
 * eventsDropped 0) while the worker was ingesting hundreds of signatures a
 * second. Counters therefore come from runtime_snapshots, which the worker
 * publishes every 30s.
 *
 * Fails closed: if the snapshot is missing or stale, `worker.state` says so and
 * the counters are null. A stopped worker must never look like an idle one.
 */
export async function GET() {
  await bootDb();
  const [worker, counts] = await Promise.all([
    fetchWorkerIngestStats(),
    cached("counts:boot", 5_000, () => countSinceBoot()),
  ]);

  const i = worker.ingest ?? {};
  const num = (k: string): number | null => {
    const v = i[k];
    return typeof v === "number" ? v : null;
  };

  return NextResponse.json({
    worker: {
      state: worker.workerState, // live | stale | unavailable
      snapshotAgeSec: worker.ageSec,
      capturedAt: worker.capturedAt,
    },
    // null (not 0) whenever the worker's state is unknown.
    connState: worker.workerState === "live" ? (i.connState ?? null) : null,
    endpoint: worker.workerState === "live" ? (i.endpoint ?? null) : null,
    signaturesSeen: num("signaturesSeen"),
    eventsParsed: num("eventsParsed"),
    eventsInserted: num("eventsInserted"),
    eventsDropped: num("eventsDropped"),
    decodeErrors: num("decodeErrors"),
    reconnects: num("reconnects"),
    queueDepthMax: num("queueDepthMax"),
    queueMax: num("queueMax"),
    decodeMsMax: num("decodeMsMax"),
    flushMsLast: num("flushMsLast"),
    flushMsMax: num("flushMsMax"),
    lastEventAgeSec: num("lastEventAgeSec"),
    lastError: worker.workerState === "live" ? (i.lastError ?? null) : null,
    // Sourced from the database, so it is valid regardless of worker state.
    counts,
    serverNow: Date.now(),
  });
}
