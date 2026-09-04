/**
 * Release a stale worker singleton advisory lock when no worker is running
 * but Postgres still holds the lock from a crashed/killed process.
 *
 * Run: pnpm worker:unlock
 */
import { bootDb, getPool } from "@/lib/db/client";
import { fetchHeartbeats } from "@/lib/runtime/worker-heartbeat-db";
import { WORKER_ADVISORY_KEY } from "@/lib/runtime/worker-lock";
import { env } from "@/lib/env";

/**
 * A worker is considered alive while any lane has beaten within this window.
 * Sourced from WORKER_HEARTBEAT_TIMEOUT_MS so this script and
 * /api/runtime/health cannot disagree about whether a worker is running — a
 * hard-coded 45s here previously called a worker dead that health called alive.
 */
const STALE_MS = env().WORKER_HEARTBEAT_TIMEOUT_MS;

/** Only advisory locks on OUR key, in OUR database. */
const LOCK_FILTER = `
  l.locktype = 'advisory'
  AND l.objsubid = 1
  AND ((l.classid::bigint << 32) | l.objid::bigint) = $1::bigint
  AND a.datname = current_database()
  AND l.pid <> pg_backend_pid()
`;

async function main() {
  await bootDb();
  const pool = getPool();

  const beats = await fetchHeartbeats();
  const newest = beats.reduce<number>((best, b) => {
    const t = b.lastBeat instanceof Date ? b.lastBeat.getTime() : new Date(b.lastBeat).getTime();
    return Math.max(best, t);
  }, 0);
  const ageMs = newest > 0 ? Date.now() - newest : Infinity;

  if (ageMs < STALE_MS) {
    console.log(
      `[worker:unlock] worker heartbeat is fresh (${Math.round(ageMs / 1000)}s ago) — a worker is already running.`,
    );
    console.log("[worker:unlock] Do NOT start a second worker. Use the existing terminal or Ctrl+C it first.");
    await pool.end();
    return;
  }

  const before = await pool.query<{ pid: number; state: string }>(
    `SELECT l.pid, a.state
     FROM pg_locks l
     JOIN pg_stat_activity a ON a.pid = l.pid
     WHERE ${LOCK_FILTER}`,
    [WORKER_ADVISORY_KEY],
  );

  if (before.rows.length === 0) {
    console.log("[worker:unlock] no advisory lock found — safe to run: pnpm worker");
    await pool.end();
    return;
  }

  console.log("[worker:unlock] stale lock detected (no recent heartbeat). Clearing our key only…");
  for (const row of before.rows) {
    console.log(`  pid=${row.pid} state=${row.state}`);
    const term = await pool.query<{ ok: boolean }>(
      "SELECT pg_terminate_backend($1) AS ok",
      [row.pid],
    );
    console.log(`  terminated pid=${row.pid}: ${term.rows[0]?.ok ? "ok" : "failed"}`);
  }

  const after = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n
     FROM pg_locks l
     JOIN pg_stat_activity a ON a.pid = l.pid
     WHERE ${LOCK_FILTER}`,
    [WORKER_ADVISORY_KEY],
  );

  const remaining = after.rows[0]?.n ?? 0;
  if (remaining === 0) {
    console.log("[worker:unlock] lock cleared — run: pnpm worker");
  } else {
    console.error(`[worker:unlock] ${remaining} lock(s) still held — retry or: docker compose restart postgres`);
    process.exit(1);
  }

  await pool.end();
}

main().catch((e) => {
  console.error("[worker:unlock] failed:", e);
  process.exit(1);
});
