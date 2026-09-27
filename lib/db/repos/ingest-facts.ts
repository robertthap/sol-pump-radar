import "server-only";
import { getDb } from "@/lib/db/client";
import type { ParsedPumpEvent } from "@/lib/pump/parser";
import { ingestFacts } from "@spr/db";

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

function factRow(e: ParsedPumpEvent) {
  const mint = "mint" in e ? e.mint : null;
  return {
    signature: e.signature,
    mint,
    raw: toJsonSafe(e),
    dedupeKey: `ingest:${e.signature}:${e.kind}`,
  };
}

/** Insert ingest audit rows; returns { inserted, deduped }. */
export async function insertIngestFacts(batch: ParsedPumpEvent[]): Promise<{
  inserted: number;
  deduped: number;
}> {
  if (batch.length === 0) return { inserted: 0, deduped: 0 };
  // This used to issue one awaited INSERT per event while the ingestor's flush
  // lock was held. At mainnet traffic rates a 500-event audit batch took over a
  // minute, overflowed the live queue, and made every strategy's tape stale.
  // One set-based INSERT preserves the same dedupe semantics without blocking
  // the strategy feed behind hundreds of round trips.
  const insertedRows = await getDb()
    .insert(ingestFacts)
    .values(batch.map(factRow))
    .onConflictDoNothing({ target: ingestFacts.dedupeKey })
    .returning({ id: ingestFacts.id });
  const inserted = insertedRows.length;
  return { inserted, deduped: batch.length - inserted };
}
