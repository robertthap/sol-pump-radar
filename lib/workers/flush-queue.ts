/**
 * Queue and watermark discipline for the ingest flush loop (H07) — PURE, no IO.
 *
 * Three rules, each closing a way the old loop lost events silently:
 *
 *  1. A batch is only GONE once the database says it is committed. The old loop
 *     spliced the batch out of the buffer before inserting it, so any insert
 *     failure logged a line and dropped those events on the floor.
 *
 *  2. The watermark follows COMMITS, not arrivals. The old loop advanced it the
 *     moment a notification was decoded, so after a failed flush the watermark
 *     already covered events that were never stored — and because gap detection
 *     starts from the watermark, the hole was invisible to the recovery path
 *     that exists to find exactly that.
 *
 *  3. When the buffer genuinely cannot hold a returned batch, drop the NEWEST
 *     and say how many. Events near the watermark are the ones gap recovery can
 *     still reach contiguously; the newest are the cheapest to re-fetch.
 */

export type Watermark = { slot: bigint; sig: string | null; ts: Date };

/** Take up to `max` items for a flush WITHOUT removing them from the buffer. */
export function peekBatch<T>(buffer: readonly T[], max: number): T[] {
  if (max <= 0) return [];
  return buffer.slice(0, Math.min(buffer.length, max));
}

/**
 * Drop a batch from the front of the buffer after the database confirmed it.
 * Returns how many were removed; items added while the flush was in flight stay.
 */
export function commitBatch<T>(buffer: T[], committed: number): number {
  if (committed <= 0) return 0;
  const n = Math.min(committed, buffer.length);
  buffer.splice(0, n);
  return n;
}

/**
 * The highest watermark that may be PERSISTED, given what actually committed.
 *
 * Never moves backwards (a late small batch cannot rewind it) and never moves
 * forward on nothing.
 */
export function advanceWatermark(
  current: Watermark | null,
  committed: Watermark | null,
): Watermark | null {
  if (!committed) return current;
  if (!current) return committed;
  return committed.slot > current.slot ? committed : current;
}

/**
 * The watermark a committed batch justifies: its own highest slot, or null.
 *
 * Slots arrive as `bigint` from the parser and as `number` from JSON, so both
 * are accepted rather than converted at every call site — a conversion is
 * exactly where a slot silently loses precision.
 */
export function batchWatermark<
  T extends { slot?: number | bigint | null; signature?: string | null },
>(batch: readonly T[], now: Date): Watermark | null {
  let best: Watermark | null = null;
  for (const e of batch) {
    const slot = e.slot;
    if (slot == null) continue;
    if (typeof slot === "number" && (!Number.isFinite(slot) || slot <= 0)) continue;
    const asBig = typeof slot === "bigint" ? slot : BigInt(Math.trunc(slot));
    if (asBig <= 0n) continue;
    if (!best || asBig > best.slot) best = { slot: asBig, sig: e.signature ?? null, ts: now };
  }
  return best;
}

export type Overflow = { restored: number; dropped: number };

/**
 * Put an uncommitted batch back at the FRONT of the buffer, preserving order.
 *
 * If the buffer cannot hold everything, the NEWEST items are dropped and
 * counted — never silently, and never the oldest, which are the ones gap
 * recovery can still stitch to the watermark.
 */
export function restoreBatch<T>(buffer: T[], batch: readonly T[], maxBuffer: number): Overflow {
  if (batch.length === 0) return { restored: 0, dropped: 0 };
  const capacity = Math.max(0, maxBuffer);
  buffer.unshift(...batch);
  if (buffer.length <= capacity) return { restored: batch.length, dropped: 0 };
  const dropped = buffer.length - capacity;
  buffer.splice(capacity, dropped);
  return { restored: batch.length, dropped };
}
