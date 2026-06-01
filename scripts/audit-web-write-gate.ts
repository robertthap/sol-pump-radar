/**
 * Audit mutating API routes for executeWebMutation / queueWebCommand usage.
 * Run: pnpm audit:web-writes
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const API = join(ROOT, "app", "api");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (name === "route.ts") out.push(p);
  }
  return out;
}

function hasMutator(src: string): boolean {
  return /export async function (POST|PUT|PATCH|DELETE)\b/.test(src);
}

function isGated(src: string): boolean {
  return /executeWebMutation|queueWebCommand/.test(src);
}

function hasDirectSqlWrite(src: string): boolean {
  return /\b(INSERT INTO|UPDATE \w+ SET|DELETE FROM)\b/.test(src);
}

function main() {
  const routes = walk(API);
  const mutating = routes.filter((f) => hasMutator(readFileSync(f, "utf8")));
  const ungated: string[] = [];
  const gated: string[] = [];
  const ungatedWithSql: string[] = [];

  for (const file of mutating) {
    const src = readFileSync(file, "utf8");
    const rel = relative(ROOT, file).replace(/\\/g, "/");
    if (isGated(src)) {
      gated.push(rel);
    } else {
      ungated.push(rel);
      if (hasDirectSqlWrite(src)) ungatedWithSql.push(rel);
    }
  }

  console.log("[audit] mutating API routes:", mutating.length);
  console.log("[audit] gated (executeWebMutation | queueWebCommand):", gated.length);
  for (const r of gated.sort()) console.log("  ✓", r);

  console.log("[audit] ungated mutators:", ungated.length);
  for (const r of ungated.sort()) console.log("  ·", r, ungatedWithSql.includes(r) ? "(has SQL write)" : "(no DB write / filesystem)");

  if (ungatedWithSql.length > 0) {
    console.error("[audit] FAIL — ungated routes with direct SQL writes:");
    for (const r of ungatedWithSql) console.error("  !", r);
    process.exit(1);
  }
  console.log("[audit] PASS — no ungated direct SQL writes in app/api");
}

main();
