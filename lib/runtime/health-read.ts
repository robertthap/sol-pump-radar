import "server-only";
import {
  buildWorkerIngestStats,
  type WorkerIngestStats,
} from "@/lib/runtime/worker-ingest-stats";
export { INGEST_SNAPSHOT_STALE_MS, type WorkerIngestStats } from "@/lib/runtime/worker-ingest-stats";

import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";

export type IngestHealthMetrics = {
  lastEventAt: string | null;
  eventsLast60s: number;
  drops1h: number;
  dropBatches1h: number;
  lastDomainEventAt: string | null;
};

export async function fetchIngestHealthMetrics(): Promise<IngestHealthMetrics> {
  const recent = await getDb().execute(sql`
    SELECT
      (SELECT MAX(ts) FROM events) AS last_event_at,
      (SELECT COUNT(*)::int FROM events WHERE ts > now() - interval '60 seconds') AS events_60s,
      (SELECT COUNT(*)::int FROM domain_events
       WHERE type = 'INGEST_DROPPED' AND occurred_at > now() - interval '1 hour') AS drop_batches_1h,
      (SELECT COALESCE(SUM((payload->>'dropped')::int), 0)::int FROM domain_events
       WHERE type = 'INGEST_DROPPED' AND occurred_at > now() - interval '1 hour') AS drops_1h,
      (SELECT MAX(occurred_at) FROM domain_events) AS last_domain_event_at
  `);
  type R = {
    last_event_at: string | null;
    events_60s: number;
    drop_batches_1h: number;
    drops_1h: number;
    last_domain_event_at: string | null;
  };
  const row = (recent as unknown as { rows: R[] }).rows[0];
  return {
    lastEventAt: row?.last_event_at ?? null,
    eventsLast60s: row?.events_60s ?? 0,
    drops1h: row?.drops_1h ?? 0,
    dropBatches1h: row?.drop_batches_1h ?? 0,
    lastDomainEventAt: row?.last_domain_event_at ?? null,
  };
}

export async function fetchLatestRuntimeSnapshotPayload(): Promise<Record<string, unknown> | null> {
  try {
    const snap = await getDb().execute(sql`
      SELECT payload FROM runtime_snapshots ORDER BY captured_at DESC LIMIT 1
    `);
    return (
      (snap as unknown as { rows: Array<{ payload: Record<string, unknown> }> }).rows[0]?.payload ??
      null
    );
  } catch {
    return null;
  }
}

export async function fetchWorkerIngestStats(): Promise<WorkerIngestStats> {
  try {
    const res = await getDb().execute(sql`
      SELECT captured_at,
             EXTRACT(EPOCH FROM (now() - captured_at)) * 1000 AS age_ms,
             payload->'ingest' AS ingest
      FROM runtime_snapshots ORDER BY captured_at DESC LIMIT 1
    `);
    const row = (res as unknown as {
      rows: Array<{ captured_at: string; age_ms: string | number; ingest: Record<string, unknown> | null }>;
    }).rows[0];
    return buildWorkerIngestStats(row);
  } catch {
    return { workerState: "unavailable", ageSec: null, capturedAt: null, ingest: null };
  }
}

export type RuntimeSnapshotSparkPoint = {
  at: string;
  rpcScore: number | null;
  openPaper: number | null;
};

export async function fetchRuntimeSnapshotSparkline(
  hours = 24,
  limit = 96,
): Promise<RuntimeSnapshotSparkPoint[]> {
  try {
    const hist = await getDb().execute(sql`
      SELECT captured_at AS at,
             (payload->'rpc'->>'rpcScore')::int AS rpc_score,
             (payload->'positions'->>'openPaper')::int AS open_paper
      FROM runtime_snapshots
      WHERE captured_at > now() - (${sql.raw(String(hours))} || ' hours')::interval
      ORDER BY captured_at ASC
      LIMIT ${limit}
    `);
    return (
      hist as unknown as {
        rows: Array<{ at: string; rpc_score: number | null; open_paper: number | null }>;
      }
    ).rows.map((r) => ({
      at: r.at,
      rpcScore: r.rpc_score,
      openPaper: r.open_paper,
    }));
  } catch {
    return [];
  }
}

export async function pingDb(): Promise<void> {
  await getDb().execute(sql`SELECT 1`);
}
