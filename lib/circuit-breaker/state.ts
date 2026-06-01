import "server-only";
import { desc } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { cbEvents } from "@/lib/db/schema";
import { logger } from "@/lib/log";
import type { CbState } from "@/lib/shared/types";

const log = logger("cb");

const VALID: CbState[] = ["RUNNING", "DEGRADED", "PAUSED", "HALTED"];

export async function readState(): Promise<{
  state: CbState;
  reason: string;
  ts: Date | null;
}> {
  const db = getDb();
  const latest = await db.select().from(cbEvents).orderBy(desc(cbEvents.ts)).limit(1);
  if (!latest.length) return { state: "RUNNING", reason: "no events yet", ts: null };
  const row = latest[0]!;
  const state = (VALID as string[]).includes(row.state) ? (row.state as CbState) : "RUNNING";
  return { state, reason: row.reason, ts: row.ts };
}

export async function transition(state: CbState, reason: string, details?: unknown) {
  const db = getDb();
  await db.insert(cbEvents).values({
    state,
    reason,
    severity: state === "HALTED" ? "critical" : state === "PAUSED" ? "error" : "info",
    details: details ?? null,
  });
  log.warn(`state -> ${state}`, { reason });
}

export async function ensureInitialState() {
  const cur = await readState();
  if (cur.ts == null) await transition("RUNNING", "boot");
}
