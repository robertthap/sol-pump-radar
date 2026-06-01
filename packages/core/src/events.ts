/**
 * Trade identity on command payloads: correlation_id (UI poll), session_id (auto/paper),
 * strategy_id (manual_demo | auto_trader | phantom_live | shadow_learner). trade_id is
 * assigned by the worker after execution — never use timestamp alone.
 */
import type { PoolClient } from "pg";
import { getRuntimeDb, domainEvents } from "@spr/db";
import { eq } from "drizzle-orm";

export type DomainEventType =
  | "INGEST_RECEIVED"
  | "INGEST_DROPPED"
  | "SIGNAL_CREATED"
  | "TRADE_INTENT"
  | "TRADE_OPENED"
  | "TRADE_CLOSED"
  | "TRADE_FAILED"
  | "PERF_BREACH"
  | "RECONCILE_BOOT"
  | "METRICS_SNAPSHOT"
  | "PAPER_TRADE_OPENED"
  | "PAPER_TRADE_CLOSED"
  | "PAPER_RESET_COMPLETED"
  | "PAPER_MARK_TO_MARKET";

export type AppendEventInput = {
  type: DomainEventType | string;
  payload: Record<string, unknown>;
  dedupeKey?: string | null;
  correlationId?: string | null;
  sessionId?: bigint | null;
};

/**
 * Append a domain event.
 *
 * Two call styles:
 *  - Object form (preferred): appendEvent({ type, payload, ... }, client?)
 *  - Legacy positional form: appendEvent(type, payload, dedupeKey?, correlationId?)
 *
 * When a `pg.PoolClient` is passed as the second arg, the insert participates
 * in the caller's transaction. Without it, a one-shot Drizzle insert is used.
 */
export async function appendEvent(
  input: AppendEventInput | (DomainEventType | string),
  payloadOrClient?: Record<string, unknown> | PoolClient,
  dedupeKey?: string | null,
  correlationId?: string | null,
): Promise<bigint> {
  let normalized: AppendEventInput;
  let client: PoolClient | undefined;

  if (typeof input === "object" && input !== null && "type" in input) {
    normalized = input;
    if (payloadOrClient && typeof (payloadOrClient as PoolClient).query === "function") {
      client = payloadOrClient as PoolClient;
    }
  } else {
    normalized = {
      type: input,
      payload: (payloadOrClient as Record<string, unknown>) ?? {},
      dedupeKey: dedupeKey ?? null,
      correlationId: correlationId ?? null,
    };
  }

  const dk = normalized.dedupeKey ?? null;
  const cid = normalized.correlationId ?? null;
  const sid = normalized.sessionId ?? null;

  if (client) {
    if (dk) {
      const existing = await client.query<{ id: string }>(
        "SELECT id::text AS id FROM domain_events WHERE dedupe_key = $1 LIMIT 1",
        [dk],
      );
      if (existing.rows.length) return BigInt(existing.rows[0]!.id);
    }
    const r = await client.query<{ id: string }>(
      `INSERT INTO domain_events (type, payload, dedupe_key, correlation_id, session_id)
       VALUES ($1, $2::jsonb, $3, $4, $5)
       RETURNING id::text AS id`,
      [
        normalized.type,
        JSON.stringify(normalized.payload),
        dk,
        cid,
        sid != null ? sid.toString() : null,
      ],
    );
    return BigInt(r.rows[0]!.id);
  }

  const db = getRuntimeDb();
  if (dk) {
    const existing = await db
      .select({ id: domainEvents.id })
      .from(domainEvents)
      .where(eq(domainEvents.dedupeKey, dk))
      .limit(1);
    if (existing.length) return existing[0]!.id;
  }
  const [row] = await db
    .insert(domainEvents)
    .values({
      type: normalized.type,
      payload: normalized.payload,
      dedupeKey: dk,
      correlationId: cid,
      sessionId: sid,
    } as never)
    .returning({ id: domainEvents.id });
  return row!.id;
}
