import { pgTable, varchar, doublePrecision, timestamp, index } from "drizzle-orm/pg-core";

export const trendCandidates = pgTable(
  "trend_candidates",
  {
    mint: varchar("mint", { length: 64 }).primaryKey(),
    vSol: doublePrecision("v_sol"),
    prevVSol: doublePrecision("prev_v_sol"),
    lastTradeAt: timestamp("last_trade_at", { withTimezone: true }),
    source: varchar("source", { length: 32 }).notNull().default("pump"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    updatedAtIdx: index("trend_candidates_updated_at_idx").on(t.updatedAt),
    lastTradeAtIdx: index("trend_candidates_last_trade_at_idx").on(t.lastTradeAt),
  }),
);

export type TrendCandidate = typeof trendCandidates.$inferSelect;
export type NewTrendCandidate = typeof trendCandidates.$inferInsert;
