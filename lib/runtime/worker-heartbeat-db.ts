import "server-only";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { logger } from "@/lib/log";

const log = logger("worker-heartbeat-db");

/**
 * DB-backed worker heartbeat. Stored in a single-row table so the web side
 * can read worker liveness via Postgres only — no filesystem IPC.
 *
 * The table is created lazily on first write; idempotent on repeat boots.
 */
let ensured = false;

async function ensureTable(): Promise<void> {
  if (ensured) return;
  await getDb().execute(sql`
    CREATE TABLE IF NOT EXISTS worker_heartbeat (
      name VARCHAR(64) PRIMARY KEY,
      last_beat TIMESTAMPTZ NOT NULL DEFAULT now(),
      tick_ms INTEGER
    )
  `);
  ensured = true;
}

export async function touchWorkerDb(name: string, tickMs?: number): Promise<void> {
  try {
    await ensureTable();
    await getDb().execute(sql`
      INSERT INTO worker_heartbeat (name, last_beat, tick_ms)
      VALUES (${name}, now(), ${tickMs ?? null})
      ON CONFLICT (name) DO UPDATE
      SET last_beat = now(),
          tick_ms = COALESCE(EXCLUDED.tick_ms, worker_heartbeat.tick_ms)
    `);
  } catch (e) {
    log.warn("touchWorkerDb failed", { name, err: String(e) });
  }
}

export async function fetchHeartbeats(): Promise<Array<{ name: string; lastBeat: Date; tickMs: number | null }>> {
  await ensureTable();
  const r = await getDb().execute(sql`
    SELECT name, last_beat AS "lastBeat", tick_ms AS "tickMs"
    FROM worker_heartbeat
    ORDER BY name
  `);
  return (r as unknown as { rows: Array<{ name: string; lastBeat: Date; tickMs: number | null }> })
    .rows;
}
