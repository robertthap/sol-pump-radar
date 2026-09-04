import "server-only";
import type { PoolClient } from "pg";
import { getPool } from "@/lib/db/client";
import { logger } from "@/lib/log";

const log = logger("worker-lock");

// Stable advisory-lock key for "the single sol-pump-radar worker".
// Constant int — do not change without bumping all running workers.
// Postgres pg_advisory_lock takes either one int8 or two int4s; we use one int8.
/** Singleton advisory-lock key. Exported so `worker:unlock` filters pg_locks on
 *  THIS key instead of terminating every advisory-lock holder in the database. */
export const WORKER_ADVISORY_KEY = 0x5350525f57524e30; // ASCII "SPR_WRN0"
const ADVISORY_KEY = WORKER_ADVISORY_KEY;

let lockClient: PoolClient | null = null;

/**
 * Acquire a session-scoped Postgres advisory lock so exactly one worker can
 * run against this database. Crashes the process if another worker already
 * holds the lock — that is the safety contract.
 *
 * The lock is held by a dedicated pooled client kept open for the worker's
 * lifetime. The client is *not* released until shutdown, so the lock survives
 * idle periods.
 */
export async function acquireWorkerSingleton(): Promise<void> {
  if (lockClient) return;
  const pool = getPool();
  const client = await pool.connect();
  try {
    const r = await client.query<{ ok: boolean }>("SELECT pg_try_advisory_lock($1) AS ok", [
      ADVISORY_KEY,
    ]);
    if (!r.rows[0]?.ok) {
      client.release();
      throw new Error(
        "Another apps/worker is already running against this DATABASE_URL. " +
          "Stop the other process (Ctrl+C) and retry. Only ONE worker is allowed.",
      );
    }
    lockClient = client;
    log.info("worker singleton lock acquired");
  } catch (e) {
    try {
      client.release();
    } catch {
      /* already released */
    }
    throw e;
  }
}

export async function releaseWorkerSingleton(): Promise<void> {
  if (!lockClient) return;
  try {
    await lockClient.query("SELECT pg_advisory_unlock($1)", [ADVISORY_KEY]);
  } catch (e) {
    log.warn("advisory_unlock failed", { err: String(e) });
  } finally {
    try {
      lockClient.release();
    } catch {
      /* ignore */
    }
    lockClient = null;
    log.info("worker singleton lock released");
  }
}
