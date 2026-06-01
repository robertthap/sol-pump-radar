import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { runtimeSchema } from "./schema-runtime";

let pool: pg.Pool | null = null;
let db: ReturnType<typeof drizzle<typeof runtimeSchema>> | null = null;

export function getDatabaseUrl(): string {
  const u = process.env.DATABASE_URL?.trim();
  if (!u) throw new Error("DATABASE_URL is required for @spr/db (Docker Postgres).");
  return u;
}

/** Single shared pool per process. Safe mode: call endPool() on DB failure. */
export function connectDb() {
  if (db) return db;
  pool = new pg.Pool({ connectionString: getDatabaseUrl(), max: 8, idleTimeoutMillis: 30_000 });
  db = drizzle(pool, { schema: runtimeSchema });
  return db;
}

export function getPool(): pg.Pool {
  if (!pool) connectDb();
  return pool!;
}

export function getRuntimeDb() {
  return connectDb();
}

export async function endPool() {
  if (pool) {
    await pool.end();
    pool = null;
    db = null;
  }
}

