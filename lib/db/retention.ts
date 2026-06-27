import "server-only";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { env } from "@/lib/env";
import { logger } from "@/lib/log";

const log = logger("retention");

export async function runRetentionPrune(): Promise<{
  events: number;
  traces: number;
  continuationEvents: number;
  engineBTraces: number;
}> {
  const days = env().EVENT_RETENTION_DAYS;
  const db = getDb();

  const rowCount = (r: unknown) =>
    Number((r as { rowCount?: number }).rowCount ?? 0);

  const events = await db.execute(sql`
    DELETE FROM events WHERE ts < now() - (${sql.raw(String(days))} || ' days')::interval
  `);
  const traces = await db.execute(sql`
    DELETE FROM decision_trace WHERE ts < now() - (${sql.raw(String(days))} || ' days')::interval
  `);
  const continuationEvents = await db.execute(sql`
    DELETE FROM continuation_events WHERE ts < now() - (${sql.raw(String(days))} || ' days')::interval
  `);
  let engineBTracesN = 0;
  try {
    const engineBTraces = await db.execute(sql`
      DELETE FROM engine_b_traces WHERE ts < now() - (${sql.raw(String(days))} || ' days')::interval
    `);
    engineBTracesN = rowCount(engineBTraces);
  } catch {
    /* optional table */
  }

  // High-churn tables that were previously UNBOUNDED and were pegging the CPU
  // (token_features ~6GB, ingest_facts ~1.5GB). Only the LATEST token_features
  // row per mint is ever read live, and the measurement backbone already keeps
  // point-in-time copies in feature_snapshots — so a short window is safe and
  // dramatically lighter (faster queries → faster intelligence/auto ticks →
  // faster entries, which the eval data shows is what wins). Chunked so the
  // first big catch-up delete never holds a long lock.
  const chunkPrune = async (table: string, tsCol: string, olderThan: string): Promise<number> => {
    let total = 0;
    try {
      // Up to 7.5M rows/run in 50k chunks — enough to clear the one-time backlog
      // in the first hourly run, then maintains (each chunk is a small, quick lock).
      for (let i = 0; i < 150; i++) {
        const r = await db.execute(
          sql.raw(
            `DELETE FROM ${table} WHERE ctid IN (` +
              `SELECT ctid FROM ${table} WHERE ${tsCol} < now() - interval '${olderThan}' LIMIT 50000)`,
          ),
        );
        const n = rowCount(r);
        total += n;
        if (n < 50000) break;
      }
    } catch {
      /* optional table */
    }
    return total;
  };

  const tokenFeaturesN = await chunkPrune("token_features", "ts", "2 days");
  const ingestFactsN = await chunkPrune("ingest_facts", "created_at", `${days} days`);

  const counts = {
    events: rowCount(events),
    traces: rowCount(traces),
    continuationEvents: rowCount(continuationEvents),
    engineBTraces: engineBTracesN,
    tokenFeatures: tokenFeaturesN,
    ingestFacts: ingestFactsN,
  };

  if (Object.values(counts).some((n) => n > 0)) {
    log.info("retention prune", { days, ...counts });
  }
  return counts;
}
