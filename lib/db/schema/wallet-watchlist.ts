import { pgTable, varchar, boolean, timestamp, index } from "drizzle-orm/pg-core";

/**
 * Operator-supplied wallets to follow ("smart money").
 *
 * Separate from `wallet_profiles` on purpose. That table is our own statistical
 * scoring; this one is operator judgement. They are joined at entry time but
 * never merged, so neither can silently overrule the other.
 *
 * See drizzle/0027_wallet_watchlist.sql for why the statistical table cannot
 * currently validate these wallets (curve-only ingestion).
 */
export const walletWatchlist = pgTable(
  "wallet_watchlist",
  {
    wallet: varchar("wallet", { length: 64 }).primaryKey(),
    label: varchar("label", { length: 64 }),
    note: varchar("note", { length: 200 }),
    active: boolean("active").notNull().default(true),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("wallet_watchlist_active_idx").on(t.active)],
);
