import { getRuntimeDb, domainEvents } from "@spr/db";
import { desc, gt, asc } from "drizzle-orm";

export async function replayDomainEventsSince(afterId: bigint, limit = 500) {
  const db = getRuntimeDb();
  return db
    .select()
    .from(domainEvents)
    .where(gt(domainEvents.id, afterId))
    .orderBy(asc(domainEvents.id))
    .limit(limit);
}

/** Recent domain_events tail counts (boot diagnostics only — not replay). */
export async function summarizeReplayTail(limit = 100) {
  const db = getRuntimeDb();
  const rows = await db
    .select()
    .from(domainEvents)
    .orderBy(desc(domainEvents.id))
    .limit(limit);
  const byType: Record<string, number> = {};
  for (const r of rows) {
    byType[r.type] = (byType[r.type] ?? 0) + 1;
  }
  return {
    fromId: rows.at(-1) ? String(rows.at(-1)!.id) : null,
    toId: rows[0] ? String(rows[0].id) : null,
    byType,
  };
}
