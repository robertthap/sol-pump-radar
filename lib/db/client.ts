import "server-only";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { connectDb, getPool as getDbPool } from "@spr/db";
import * as schema from "./schema";
import { runMigrations } from "./migrate";
import { logger } from "@/lib/log";

const log = logger("db");

/**
 * Single canonical Postgres access for both apps/web and apps/worker.
 *
 * `@spr/db` owns the pg.Pool; this module wraps it with the legacy Drizzle
 * schema bundle that the lib/* repos depend on. There must be exactly ONE
 * pg.Pool per process — the one in @spr/db. Anything else is a bug.
 */

declare global {
  // eslint-disable-next-line no-var
  var __spr_db__: ReturnType<typeof drizzle<typeof schema>> | undefined;
  // eslint-disable-next-line no-var
  var __spr_db_ready__: boolean | undefined;
}

export async function bootDb() {
  const t0 = Date.now();
  const wasReady = !!globalThis.__spr_db_ready__;
  if (wasReady) return getDb();

  log.info("opening Postgres pool (shared @spr/db)");
  // Force @spr/db to materialise its pool.
  connectDb();
  await runMigrations(getDbPool());

  if (!globalThis.__spr_db__) {
    globalThis.__spr_db__ = drizzle(getDbPool(), { schema });
  }
  globalThis.__spr_db_ready__ = true;
  log.info("Postgres ready");
  const { recordBootDb } = await import("@/lib/runtime/perf-tracker");
  recordBootDb(Date.now() - t0, !wasReady);
  return getDb();
}

export function getDb() {
  if (!globalThis.__spr_db__) {
    throw new Error("Database not booted. Call bootDb() first.");
  }
  return globalThis.__spr_db__;
}

export function getPool(): pg.Pool {
  return getDbPool();
}

export type Db = ReturnType<typeof getDb>;
export { schema };
