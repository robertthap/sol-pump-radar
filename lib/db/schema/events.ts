import {
  pgTable,
  bigserial,
  bigint,
  integer,
  varchar,
  timestamp,
  jsonb,
  doublePrecision,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const events = pgTable(
  "events",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    signature: varchar("signature", { length: 96 }).notNull(),
    instructionIndex: integer("instruction_index").notNull().default(0),
    slot: bigint("slot", { mode: "bigint" }).notNull(),
    ts: timestamp("ts", { withTimezone: true }).notNull(),
    kind: varchar("kind", { length: 24 }).notNull(),
    mint: varchar("mint", { length: 64 }),
    wallet: varchar("wallet", { length: 64 }),
    side: varchar("side", { length: 8 }),
    solAmount: doublePrecision("sol_amount"),
    tokenAmount: doublePrecision("token_amount"),
    vSolAfter: doublePrecision("v_sol_after"),
    program: varchar("program", { length: 64 }),
    // T1.2 — trading venue. 'curve' (bonding curve, the default for all prior
    // rows) or 'pumpswap' (post-graduation DEX). Curve-only consumers (M1
    // graduation math) filter venue='curve'; wallet history + labels span both.
    venue: varchar("venue", { length: 16 }).notNull().default("curve"),
    // T1.2 — PumpSwap pool/pair address (null for curve events).
    pool: varchar("pool", { length: 64 }),
    // Provenance of `ts`: 'chain' when the on-chain blockTime was present and
    // plausible, 'local' when we fell back to the receive clock (see
    // classifyBlockTime). NULL on rows written before this column existed — their
    // provenance is genuinely unknown, so latency math must exclude them rather
    // than assume chain time.
    tsSource: varchar("ts_source", { length: 8 }),
    raw: jsonb("raw"),
  },
  (t) => ({
    sigUnq: uniqueIndex("events_sig_ix_uq").on(t.signature, t.instructionIndex),
    mintTs: index("events_mint_ts_idx").on(t.mint, t.ts),
    walletTs: index("events_wallet_ts_idx").on(t.wallet, t.ts),
    slot: index("events_slot_idx").on(t.slot),
    kind: index("events_kind_idx").on(t.kind),
    mintVenueTs: index("events_mint_venue_ts_idx").on(t.mint, t.venue, t.ts),
    walletVenueTs: index("events_wallet_venue_ts_idx").on(t.wallet, t.venue, t.ts),
  }),
);

export const parseErrors = pgTable("parse_errors", {
  id: bigserial("id", { mode: "bigint" }).primaryKey(),
  signature: varchar("signature", { length: 96 }).notNull(),
  slot: bigint("slot", { mode: "bigint" }),
  ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
  reason: varchar("reason", { length: 128 }).notNull(),
  details: jsonb("details"),
});

export type EventRow = typeof events.$inferSelect;
export type NewEventRow = typeof events.$inferInsert;
