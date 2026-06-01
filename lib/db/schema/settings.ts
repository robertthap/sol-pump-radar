import { pgTable, varchar, text, timestamp, doublePrecision, index } from "drizzle-orm/pg-core";

/** Key-value overrides for trade sizing (persist across restarts). */
export const userSettings = pgTable(
  "user_settings",
  {
    key: varchar("key", { length: 64 }).primaryKey(),
    value: text("value").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    updated: index("user_settings_updated_idx").on(t.updatedAt),
  }),
);

export type UserSetting = typeof userSettings.$inferSelect;
