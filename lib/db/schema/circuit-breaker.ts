import { pgTable, bigserial, varchar, timestamp, jsonb, index } from "drizzle-orm/pg-core";

export const cbEvents = pgTable(
  "cb_events",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
    state: varchar("state", { length: 16 }).notNull(),
    severity: varchar("severity", { length: 16 }).notNull().default("info"),
    reason: varchar("reason", { length: 128 }).notNull(),
    details: jsonb("details"),
  },
  (t) => ({
    ts: index("cb_events_ts_idx").on(t.ts),
    state: index("cb_events_state_idx").on(t.state),
  }),
);
