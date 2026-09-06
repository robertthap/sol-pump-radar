import {
  pgTable,
  bigserial,
  bigint,
  timestamp,
  integer,
  doublePrecision,
  boolean,
  index,
} from "drizzle-orm/pg-core";

/**
 * Sampled P&L / health path for an OPEN paper position (~every 30s).
 *
 * Exists so exit policies can be evaluated offline against the population the
 * bot actually trades. `events` cannot serve that: graduated coins trade on
 * PumpSwap and never appear there, so most positions have no reconstructable
 * price path. See drizzle/0026_position_marks.sql.
 */
export const positionMarks = pgTable(
  "position_marks",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    positionId: bigint("position_id", { mode: "bigint" }).notNull(),
    ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
    ageS: integer("age_s").notNull(),
    pct: doublePrecision("pct").notNull(),
    peakPct: doublePrecision("peak_pct").notNull(),
    mcapUsd: doublePrecision("mcap_usd"),
    graduated: boolean("graduated").notNull().default(false),
    lastTradeAgeS: integer("last_trade_age_s"),
    curveTrades60s: integer("curve_trades_60s"),
    curveWallets60s: integer("curve_wallets_60s"),
  },
  (t) => ({
    posTsIdx: index("position_marks_pos_ts_idx").on(t.positionId, t.ts),
    tsIdx: index("position_marks_ts_idx").on(t.ts),
  }),
);
