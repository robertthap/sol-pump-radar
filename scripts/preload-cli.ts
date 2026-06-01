/**
 * CLI preload: stub `server-only` + load .env.local before Engine B scripts.
 */
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(resolve(here, "loader-server-only.mjs")).href, import.meta.url);

// Repo root = parent of this script's directory (scripts/). This makes envs
// load no matter which cwd pnpm invoked us from (root, apps/worker, etc.).
const repoRoot = resolve(here, "..");
const envLocal = resolve(repoRoot, ".env.local");
const envFile = resolve(repoRoot, ".env");
for (const f of [envLocal, envFile]) {
  if (!existsSync(f)) continue;
  const text = readFileSync(f, "utf8");
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 1) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
