import {
  pgTable,
  bigserial,
  bigint,
  smallint,
  integer,
  text,
  varchar,
  boolean,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

/**
 * T1.1 — WS Gap Recovery (v2 plan, Sprint 2).
 *
 * ingest_watermark: single-row high-water-mark of the last consumed slot. The
 * ingestor updates this on each 500ms flush; on reconnect, anything between
 * the watermark and the current head is the gap we need to recover.
 *
 * ingest_gaps: append-only log of WS coverage gaps. Each row records when a
 * gap started/ended (slot + ts) and whether per-mint backfill has recovered
 * it. The label-builder reads this table — if an unrecovered gap overlaps a
 * snapshot's horizon, the label is marked `blocked_reason='gap'` rather than
 * computed from incomplete data.
 *
 * scope: 'tracked' (per-at-risk-mint replay attempted), 'program' (full-program
 * replay attempted — only feasible for very short gaps), or 'unrecoverable'
 * (gap too long; we won't try, and the label gate will block).
 */
export const ingestWatermark = pgTable("ingest_watermark", {
  // Singleton row, id=1. The CHECK constraint lives in the migration SQL.
  id: smallint("id").primaryKey().default(1),
  lastSlot: bigint("last_slot", { mode: "bigint" }).notNull(),
  // The most recent signature we saw — used as `until=` to bound recovery
  // pagination (getSignaturesForAddress walks newest→oldest, stops at this).
  lastSig: text("last_sig"),
  lastTs: timestamp("last_ts", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const ingestGaps = pgTable(
  "ingest_gaps",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    startedSlot: bigint("started_slot", { mode: "bigint" }).notNull(),
    endedSlot: bigint("ended_slot", { mode: "bigint" }).notNull(),
    startedTs: timestamp("started_ts", { withTimezone: true }).notNull(),
    endedTs: timestamp("ended_ts", { withTimezone: true }).notNull(),
    detectedAt: timestamp("detected_at", { withTimezone: true }).notNull().defaultNow(),
    recovered: boolean("recovered").notNull().default(false),
    recoveredCount: integer("recovered_count").notNull().default(0),
    scope: varchar("scope", { length: 16 }).notNull().default("tracked"),
    note: text("note"),
  },
  (t) => ({
    // Fast overlap lookup for the label gate — only unrecovered gaps matter,
    // so this is a partial index keyed on the time window.
    openWindow: index("ingest_gaps_open_window_idx").on(t.startedTs, t.endedTs),
  }),
);

export type IngestWatermarkRow = typeof ingestWatermark.$inferSelect;
export type IngestGapRow = typeof ingestGaps.$inferSelect;
export type NewIngestGap = typeof ingestGaps.$inferInsert;
