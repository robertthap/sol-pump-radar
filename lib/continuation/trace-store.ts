import "server-only";
import { mkdir, readFile, appendFile, readdir } from "fs/promises";
import { existsSync } from "fs";
import { join, resolve } from "path";
import { sql, desc, eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { engineBTraces } from "@/lib/db/schema/continuation-intelligence";
import type { EngineBTrace } from "@/lib/continuation/types";
import { ENGINE_B_VERSION } from "@/lib/continuation/types";
import { logger } from "@/lib/log";

const log = logger("engine-b:trace");

export const JSONL_DIR = resolve("./data/engine-b-traces");

async function ensureDir() {
  if (!existsSync(JSONL_DIR)) await mkdir(JSONL_DIR, { recursive: true });
}

function dayFile(ts: number): string {
  const d = new Date(ts);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return join(JSONL_DIR, `${y}-${m}-${day}.jsonl`);
}

/** Insert-only Postgres index of Engine B traces. */
export async function insertEngineBTrace(trace: EngineBTrace): Promise<void> {
  try {
    await getDb()
      .insert(engineBTraces)
      .values({
        mint: trace.mint,
        ts: new Date(trace.timestamp),
        trace: trace as unknown as Record<string, unknown>,
        action: trace.outputs.action,
        score: trace.outputs.score,
        engineBVersion: ENGINE_B_VERSION,
      });
  } catch (e) {
    log.warn("db insert failed", { mint: trace.mint, err: String(e) });
  }
}

/** Dual-write: Postgres + JSONL (best-effort; JSONL failure never throws). */
export async function persistEngineBTrace(trace: EngineBTrace): Promise<void> {
  await insertEngineBTrace(trace);
  try {
    await ensureDir();
    await appendFile(dayFile(trace.timestamp), JSON.stringify(trace) + "\n", "utf8");
  } catch (e) {
    log.warn("jsonl append failed", { mint: trace.mint, err: String(e) });
  }
}

export async function fetchTracesForMint(
  mint: string,
  limit = 50,
): Promise<EngineBTrace[]> {
  try {
    const rows = await getDb()
      .select({ trace: engineBTraces.trace })
      .from(engineBTraces)
      .where(eq(engineBTraces.mint, mint))
      .orderBy(desc(engineBTraces.ts))
      .limit(limit);
    return rows
      .map((r) => r.trace as unknown as EngineBTrace)
      .filter((t): t is EngineBTrace => !!t && typeof t === "object");
  } catch (e) {
    log.warn("fetchTracesForMint failed", { mint, err: String(e) });
    return [];
  }
}

export async function importJsonl(file: string): Promise<number> {
  const text = await readFile(file, "utf8");
  let n = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const trace = JSON.parse(line) as EngineBTrace;
    await insertEngineBTrace(trace);
    n++;
  }
  return n;
}

export async function listJsonlFiles(): Promise<string[]> {
  if (!existsSync(JSONL_DIR)) return [];
  const files = await readdir(JSONL_DIR);
  return files.filter((f) => f.endsWith(".jsonl")).map((f) => join(JSONL_DIR, f));
}

export function tracesDataDir(): string {
  return JSONL_DIR;
}

// Re-export so existing callers do not need to add a drizzle import.
export { sql };
