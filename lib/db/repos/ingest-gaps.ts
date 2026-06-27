import "server-only";

import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";

/**
 * T1.1 — repo for WS gap-recovery state.
 *
 * `getWatermark` / `upsertWatermark` — singleton high-water-mark of the last
 * consumed slot. The ingestor upserts on each 500ms flush.
 *
 * `openGap` / `closeGap` / `markUnrecoverable` — append-only gap log. The
 * ingestor opens a gap on reconnect, then closes it once `recoverGapForMints`
 * returns; or marks unrecoverable if the gap is too long to attempt.
 *
 * `gapOverlaps` — the label-builder's gate. Returns true iff any unrecovered
 * gap overlaps the snapshot's horizon window [ts, ts + horizonSec]. If true,
 * the label must NOT be computed (would be over incomplete data) — write
 * `outcome_labels.blocked_reason = 'gap'` instead.
 */

export type Watermark = {
  lastSlot: bigint;
  lastSig: string | null;
  lastTs: Date;
};

export async function getWatermark(): Promise<Watermark | null> {
  const res = await getDb().execute(sql`
    SELECT last_slot::text AS last_slot, last_sig, last_ts FROM ingest_watermark WHERE id = 1
  `);
  type Row = { last_slot: string; last_sig: string | null; last_ts: Date | string };
  const rows = (res as unknown as { rows: Row[] }).rows;
  if (!rows.length) return null;
  const r = rows[0]!;
  return {
    lastSlot: BigInt(r.last_slot),
    lastSig: r.last_sig,
    lastTs: r.last_ts instanceof Date ? r.last_ts : new Date(r.last_ts),
  };
}

/**
 * Move the watermark forward. Idempotent and monotonic: never moves backward,
 * even on out-of-order callers. Cheap enough to call on every 500ms flush.
 */
export async function upsertWatermark(input: {
  lastSlot: bigint;
  lastSig: string | null;
  lastTs: Date;
}): Promise<void> {
  await getDb().execute(sql`
    INSERT INTO ingest_watermark (id, last_slot, last_sig, last_ts, updated_at)
    VALUES (1, ${input.lastSlot.toString()}::bigint, ${input.lastSig}, ${input.lastTs.toISOString()}::timestamptz, now())
    ON CONFLICT (id) DO UPDATE SET
      last_slot  = GREATEST(ingest_watermark.last_slot, EXCLUDED.last_slot),
      last_sig   = CASE
        WHEN EXCLUDED.last_slot >= ingest_watermark.last_slot THEN EXCLUDED.last_sig
        ELSE ingest_watermark.last_sig
      END,
      last_ts    = GREATEST(ingest_watermark.last_ts, EXCLUDED.last_ts),
      updated_at = now()
  `);
}

export async function openGap(input: {
  startedSlot: bigint;
  endedSlot: bigint;
  startedTs: Date;
  endedTs: Date;
  scope?: "tracked" | "program" | "unrecoverable";
  note?: string;
}): Promise<bigint> {
  const res = await getDb().execute(sql`
    INSERT INTO ingest_gaps
      (started_slot, ended_slot, started_ts, ended_ts, scope, note)
    VALUES
      (${input.startedSlot.toString()}::bigint,
       ${input.endedSlot.toString()}::bigint,
       ${input.startedTs.toISOString()}::timestamptz,
       ${input.endedTs.toISOString()}::timestamptz,
       ${input.scope ?? "tracked"},
       ${input.note ?? null})
    RETURNING id::text AS id
  `);
  const r = (res as unknown as { rows: Array<{ id: string }> }).rows[0]!;
  return BigInt(r.id);
}

export async function closeGap(id: bigint, recoveredCount: number, note?: string): Promise<void> {
  await getDb().execute(sql`
    UPDATE ingest_gaps
    SET recovered = true,
        recovered_count = ${recoveredCount},
        note = COALESCE(${note ?? null}, note)
    WHERE id = ${id.toString()}::bigint
  `);
}

export async function markUnrecoverable(id: bigint, note?: string): Promise<void> {
  await getDb().execute(sql`
    UPDATE ingest_gaps
    SET scope = 'unrecoverable',
        note = COALESCE(${note ?? null}, note)
    WHERE id = ${id.toString()}::bigint
  `);
}

/**
 * Returns true iff any unrecovered (and non-unrecoverable) gap overlaps the
 * window [ts, ts + horizonSec]. Used by the label-builder before computing a
 * forward return — if true, the label must be skipped/blocked.
 *
 * Uses the partial index ingest_gaps_open_window_idx (WHERE NOT recovered).
 */
export async function gapOverlaps(ts: Date, horizonSec: number): Promise<boolean> {
  const horizonEndIso = new Date(ts.getTime() + horizonSec * 1000).toISOString();
  const res = await getDb().execute(sql`
    SELECT EXISTS (
      SELECT 1 FROM ingest_gaps
      WHERE NOT recovered
        AND scope <> 'unrecoverable'
        AND started_ts <= ${horizonEndIso}::timestamptz
        AND ended_ts   >= ${ts.toISOString()}::timestamptz
    ) AS overlaps
  `);
  return Boolean((res as unknown as { rows: Array<{ overlaps: boolean }> }).rows[0]?.overlaps);
}

/** Diagnostic: count of unrecovered gaps (surfaced to UI/health). */
export async function openGapCount(): Promise<number> {
  const res = await getDb().execute(sql`
    SELECT count(*)::int AS n FROM ingest_gaps
    WHERE NOT recovered AND scope <> 'unrecoverable'
  `);
  return ((res as unknown as { rows: Array<{ n: number }> }).rows[0]?.n) ?? 0;
}
