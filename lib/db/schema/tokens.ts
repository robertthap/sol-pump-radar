import {
  pgTable,
  varchar,
  integer,
  bigint,
  text,
  timestamp,
  jsonb,
  boolean,
  index,
} from "drizzle-orm/pg-core";

export const tokens = pgTable(
  "tokens",
  {
    mint: varchar("mint", { length: 64 }).primaryKey(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    firstSeenSlot: bigint("first_seen_slot", { mode: "bigint" }),
    creator: varchar("creator", { length: 64 }),
    decimals: integer("decimals"),
    supply: text("supply"),
    name: text("name"),
    symbol: text("symbol"),
    status: varchar("status", { length: 24 }).notNull().default("active"),
    graduatedAt: timestamp("graduated_at", { withTimezone: true }),
    lastSafetyVerdict: jsonb("last_safety_verdict"),
    lastSafetyAt: timestamp("last_safety_at", { withTimezone: true }),
    blockedForTrading: boolean("blocked_for_trading").notNull().default(false),
    metadataUri: text("metadata_uri"),
  },
  (t) => ({
    creatorIdx: index("tokens_creator_idx").on(t.creator),
    statusIdx: index("tokens_status_idx").on(t.status),
    createdAtIdx: index("tokens_created_at_idx").on(t.createdAt),
  }),
);

export type Token = typeof tokens.$inferSelect;
export type NewToken = typeof tokens.$inferInsert;
