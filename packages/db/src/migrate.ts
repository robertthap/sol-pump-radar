import { readdir, readFile } from "fs/promises";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type pg from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));

function migrationsDir(): string {
  const env = process.env.SPR_MIGRATIONS_DIR;
  if (env) return env;
  return join(__dirname, "..", "..", "..", "drizzle");
}

async function ensureMigrationsTable(client: pg.PoolClient) {
  await client.query(
    "CREATE TABLE IF NOT EXISTS spr_migrations (" +
      "filename TEXT PRIMARY KEY," +
      "applied_at TIMESTAMPTZ NOT NULL DEFAULT now()" +
    ");"
  );
}

async function appliedSet(client: pg.PoolClient): Promise<Set<string>> {
  const r = await client.query<{ filename: string }>("SELECT filename FROM spr_migrations");
  return new Set(r.rows.map((x) => x.filename));
}

export async function runMigrations(pool: pg.Pool): Promise<void> {
  const dir = migrationsDir();
  if (!existsSync(dir)) {
    console.warn("[@spr/db] no migrations dir", dir);
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
      console.info("[@spr/db] applying migration", file);
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
          throw e;
        }
      }
      await client.query("INSERT INTO spr_migrations (filename) VALUES ($1)", [file]);
    }
  } finally {
    client.release();
  }
}
