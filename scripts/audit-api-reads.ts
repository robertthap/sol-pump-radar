/**
 * Audit read API routes: direct getDb() vs shared repo/helpers.
 * Run: pnpm audit:api-reads
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const API = join(ROOT, "app", "api");

const REPO_IMPORT = /@\/lib\/db\/repos\/|@\/lib\/paper\/|@\/lib\/auto\/|@\/lib\/runtime\/|@\/lib\/trade\/|fetchPostgresRuntimeSnapshot|queueWebCommand|executeWebMutation/;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (name === "route.ts") out.push(p);
  }
  return out;
}

function main() {
  const routes = walk(API);
  const withGetDb: string[] = [];
  const migrated: string[] = [];

  for (const file of routes) {
    const src = readFileSync(file, "utf8");
    if (!/export async function GET\b/.test(src)) continue;
    const rel = relative(ROOT, file).replace(/\\/g, "/");
    if (/getDb\(\)/.test(src)) {
      withGetDb.push(rel);
      if (REPO_IMPORT.test(src)) migrated.push(rel);
    }
  }

  const rawOnly = withGetDb.filter((r) => !migrated.includes(r));

  console.log("[audit] GET routes with getDb():", withGetDb.length);
  console.log("[audit] using shared read helpers:", migrated.length);
  for (const r of migrated.sort()) console.log("  ✓", r);

  console.log("[audit] raw SQL only (candidates for repo extraction):", rawOnly.length);
  for (const r of rawOnly.sort()) console.log("  ·", r);
}

main();
