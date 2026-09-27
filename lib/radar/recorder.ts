import "server-only";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { logger } from "@/lib/log";
import { BoundedMap } from "@/lib/shared/bounded-map";
import type { RadarEventStage } from "@/lib/radar/snapshot";

/**
 * Writes what the auto-trader decided about each candidate to radar_events, for the /radar screen.
 *
 * Never on the trading path's clock: record() only appends to memory, and a timer flushes batches. A pending
 * decision is re-evaluated every tick while it waits, so the same decision hitting the same gate is written at
 * most once per REPEAT_MS. If the database is unavailable rows are dropped, never retried into a growing backlog.
 */
export type RadarEventInput = {
  mint: string;
  stage: RadarEventStage;
  subStage?: string | null;
  score?: number | null;
  detail?: string | null;
  sessionId?: string | null;
  decisionId?: bigint | null;
};

const log = logger("radar");
const FLUSH_MS = 1_000;
const REPEAT_MS = 30_000;
const MAX_BUFFER = 5_000;
const PRUNE_MS = 10 * 60_000;

type Row = RadarEventInput & { at: Date };
const lastWritten = new BoundedMap<string, number>(50_000);
let buffer: Row[] = [];
let timer: ReturnType<typeof setInterval> | null = null;
let flushing = false;
let lastPruneAt = 0;
let lastErrorAt = 0;

export function recordRadarEvent(e: RadarEventInput): void {
  const now = Date.now();
  const key = `${e.decisionId?.toString() ?? e.mint}|${e.stage}|${e.subStage ?? ""}`;
  const prev = lastWritten.get(key);
  if (prev != null && now - prev < REPEAT_MS) return;
  lastWritten.set(key, now);
  if (buffer.length >= MAX_BUFFER) return;
  buffer.push({ ...e, at: new Date(now) });
  if (!timer) {
    timer = setInterval(() => void flush(), FLUSH_MS);
    timer.unref?.();
  }
}

async function flush(): Promise<void> {
  if (flushing) return;
  flushing = true;
  const batch = buffer;
  buffer = [];
  try {
    if (batch.length > 0) {
      const values = batch.map(
        (r) => sql`(${r.at.toISOString()}::timestamptz, ${r.mint}, ${r.stage}, ${r.subStage ?? null}, ${
          r.score != null && Number.isFinite(r.score) ? r.score : null
        }::float8, ${r.detail ? r.detail.slice(0, 160) : null}, ${r.sessionId ?? null}::bigint, ${
          r.decisionId != null ? r.decisionId.toString() : null
        }::bigint)`,
      );
      await getDb().execute(sql`
        INSERT INTO radar_events (ts, mint, stage, sub_stage, score, detail, session_id, decision_id)
        VALUES ${sql.join(values, sql`, `)}
      `);
    }
    if (Date.now() - lastPruneAt > PRUNE_MS) {
      lastPruneAt = Date.now();
      await getDb().execute(sql`DELETE FROM radar_events WHERE ts < now() - interval '1 day'`);
    }
  } catch (err) {
    if (Date.now() - lastErrorAt > 60_000) {
      lastErrorAt = Date.now();
      log.warn("radar events not written (the radar screen misses these gate results)", {
        rows: batch.length,
        err: String(err),
      });
    }
  } finally {
    flushing = false;
  }
}
