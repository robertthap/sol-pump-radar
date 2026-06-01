import "server-only";
import { connectDb, domainEvents, ingestFacts, signals, tradesFsm } from "@spr/db";
import { count, desc, eq, inArray } from "drizzle-orm";

export function isPostgresRuntimeConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL?.trim());
}

export async function fetchPostgresRuntimeSnapshot() {
  if (!isPostgresRuntimeConfigured()) {
    return { configured: false as const };
  }
  const db = connectDb();
  const [eventsN, factsN, signalsN, tradesN, openFsm] = await Promise.all([
    db.select({ n: count() }).from(domainEvents),
    db.select({ n: count() }).from(ingestFacts),
    db.select({ n: count() }).from(signals),
    db.select({ n: count() }).from(tradesFsm),
    db
      .select({ state: tradesFsm.state, n: count() })
      .from(tradesFsm)
      .where(inArray(tradesFsm.state, ["INTENT", "OPEN", "CLOSING"]))
      .groupBy(tradesFsm.state),
  ]);

  const recentEvents = await db
    .select({
      id: domainEvents.id,
      type: domainEvents.type,
      occurredAt: domainEvents.occurredAt,
    })
    .from(domainEvents)
    .orderBy(desc(domainEvents.id))
    .limit(10);

  const latestMetrics = await db
    .select({ payload: domainEvents.payload, occurredAt: domainEvents.occurredAt })
    .from(domainEvents)
    .where(eq(domainEvents.type, "METRICS_SNAPSHOT"))
    .orderBy(desc(domainEvents.id))
    .limit(1);

  return {
    configured: true as const,
    counts: {
      domainEvents: Number(eventsN[0]?.n ?? 0),
      ingestFacts: Number(factsN[0]?.n ?? 0),
      signals: Number(signalsN[0]?.n ?? 0),
      tradesFsm: Number(tradesN[0]?.n ?? 0),
    },
    openFsmByState: openFsm.map((r) => ({ state: r.state, count: Number(r.n) })),
    recentEvents: recentEvents.map((e) => ({
      id: String(e.id),
      type: e.type,
      occurredAt: e.occurredAt?.toISOString() ?? null,
    })),
    latestMetrics: latestMetrics[0]?.payload ?? null,
    latestMetricsAt: latestMetrics[0]?.occurredAt?.toISOString() ?? null,
  };
}
