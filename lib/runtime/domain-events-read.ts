import "server-only";

import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";

export type DomainEventRow = {
  type: string;
  payload: Record<string, unknown> & { ok?: boolean; reason?: string };
  occurredAt: Date;
};

export async function fetchEventsByCorrelationId(
  correlationId: string,
): Promise<DomainEventRow[]> {
  const res = await getDb().execute(sql`
    SELECT type, payload, occurred_at
    FROM domain_events
    WHERE correlation_id = ${correlationId}
    ORDER BY id ASC
  `);
  type Raw = {
    type: string;
    payload: Record<string, unknown> & { ok?: boolean; reason?: string };
    occurred_at: Date;
  };
  return (res as unknown as { rows: Raw[] }).rows.map((r) => ({
    type: r.type,
    payload: r.payload ?? {},
    occurredAt: r.occurred_at,
  }));
}
