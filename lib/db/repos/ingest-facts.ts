import "server-only";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import type { ParsedPumpEvent } from "@/lib/pump/parser";

/** JSON.stringify cannot handle bigint (slot on ParsedPumpEvent). */
function toJsonSafe(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(toJsonSafe);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, toJsonSafe(v)]),
    );
  }
  return value;
}

function serializeEvent(e: ParsedPumpEvent): string {
  return JSON.stringify(toJsonSafe(e));
}

function factRow(e: ParsedPumpEvent) {
  const mint = "mint" in e ? e.mint : null;
  return {
    signature: e.signature,
    mint,
    rawJson: serializeEvent(e),
    dedupeKey: `ingest:${e.signature}:${e.kind}`,
  };
}

/** Insert ingest audit rows; returns { inserted, deduped }. */
export async function insertIngestFacts(batch: ParsedPumpEvent[]): Promise<{
  inserted: number;
  deduped: number;
}> {
  if (batch.length === 0) return { inserted: 0, deduped: 0 };
  let inserted = 0;
  for (const e of batch) {
    const row = factRow(e);
    const res = await getDb().execute(sql`
      INSERT INTO ingest_facts (signature, mint, raw, dedupe_key)
      VALUES (${row.signature}, ${row.mint}, ${row.rawJson}::jsonb, ${row.dedupeKey})
      ON CONFLICT (dedupe_key) DO NOTHING
      RETURNING id
    `);
    if ((res as unknown as { rows: unknown[] }).rows.length > 0) inserted++;
  }
  return { inserted, deduped: batch.length - inserted };
}
