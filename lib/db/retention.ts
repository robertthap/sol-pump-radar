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

  const counts = {
    events: rowCount(events),
    traces: rowCount(traces),
    continuationEvents: rowCount(continuationEvents),
    engineBTraces: engineBTracesN,
  };

  if (counts.events + counts.traces + counts.continuationEvents + counts.engineBTraces > 0) {
    log.info("retention prune", { days, ...counts });
  }
  return counts;
}
