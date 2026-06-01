import {
  pgTable,
  bigserial,
  varchar,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";

export const notifications = pgTable(
  "notifications",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
    kind: varchar("kind", { length: 32 }).notNull(),
    title: varchar("title", { length: 200 }).notNull(),
    body: varchar("body", { length: 1000 }),
    mint: varchar("mint", { length: 64 }),
    severity: varchar("severity", { length: 16 }).notNull().default("info"),
    extra: jsonb("extra"),
  },
  (t) => ({
    ts: index("notifications_ts_idx").on(t.ts),
    kind: index("notifications_kind_idx").on(t.kind),
  }),
);

export type NotificationRow = typeof notifications.$inferSelect;
