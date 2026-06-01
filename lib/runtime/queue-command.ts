import { randomUUID } from "node:crypto";
import { executeWebMutation, type WebWriteOpType } from "@/lib/runtime/web-writes";

/** Insert a REQUESTED domain event through the web-write gate. */
export async function queueWebCommand(
  op: WebWriteOpType,
  eventType: string,
  payload: Record<string, unknown>,
  prefix: string,
): Promise<{ correlationId: string }> {
  const correlationId = `${prefix}-${randomUUID()}`;
  await executeWebMutation(op, async (client) => {
    await client.query(
      `INSERT INTO domain_events (type, payload, dedupe_key, correlation_id)
       VALUES ($1, $2::jsonb, $3, $4)`,
      [eventType, JSON.stringify(payload), `${prefix}:req:${correlationId}`, correlationId],
    );
  });
  return { correlationId };
}
