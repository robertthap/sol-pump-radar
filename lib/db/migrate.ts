import "server-only";
import { readdir, readFile } from "fs/promises";
import { existsSync } from "fs";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { logger } from "@/lib/log";

const log = logger("db:migrate");

/** Repo-root drizzle/ — stable regardless of process.cwd() (e.g. apps/worker). */
function resolveMigrationsDir(): string {
  const envDir = process.env.SPR_MIGRATIONS_DIR;
  if (envDir && existsSync(envDir)) return envDir;

  const fromLib = resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle");
  const fromCwd = resolve(process.cwd(), "drizzle");
  const fromCwdUp = resolve(process.cwd(), "../../drizzle");

  for (const dir of [fromLib, fromCwd, fromCwdUp]) {
    if (existsSync(dir)) return dir;
  }
  return fromLib;
}

async function ensureMigrationsTable(client: pg.PoolClient) {
  await client.query(
    "CREATE TABLE IF NOT EXISTS spr_migrations (" +
      "filename TEXT PRIMARY KEY," +
      "applied_at TIMESTAMPTZ NOT NULL DEFAULT now()" +
    ")",
  );
}

async function appliedSet(client: pg.PoolClient): Promise<Set<string>> {
  const r = await client.query<{ filename: string }>("SELECT filename FROM spr_migrations");
  return new Set(r.rows.map((x) => x.filename));
}

export async function runMigrations(pool: pg.Pool): Promise<void> {
  const dir = resolveMigrationsDir();
  if (!existsSync(dir)) {
    log.warn("no migrations dir; skipping", { dir });
    return;
  }
  const client = await pool.connect();
  try {
    await ensureMigrationsTable(client);
    const already = await appliedSet(client);

    const files = (await readdir(dir))
      .filter((f) => f.endsWith(".sql"))
      .sort();

    for (const file of files) {
      if (already.has(file)) continue;
      const fullPath = join(dir, file);
      const sqlText = await readFile(fullPath, "utf8");
      log.info("applying migration", { file });
      const statements = sqlText
        .split(/-->\s*statement-breakpoint/g)
        .map((s) => s.trim())
        .filter(Boolean);
      const toRun = statements.length ? statements : [sqlText.trim()].filter(Boolean);
      for (const stmt of toRun) {
        try {
          await client.query(stmt);
        } catch (e) {
          const msg = String(e);
          if (/already exists/i.test(msg)) continue;
          log.error("statement failed", { file, msg, stmt: stmt.slice(0, 200) });
          throw e;
        }
      }
      await client.query("INSERT INTO spr_migrations (filename) VALUES ($1)", [file]);
    }
  } finally {
    client.release();
  }
}
