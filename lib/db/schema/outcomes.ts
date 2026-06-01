import {
  pgTable,
  bigserial,
  bigint,
  varchar,
  timestamp,
  doublePrecision,
  jsonb,
  index,
} from "drizzle-orm/pg-core";

export const tradeOutcomes = pgTable(
  "trade_outcomes",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    source: varchar("source", { length: 8 }).notNull(),
    tradeId: bigint("trade_id", { mode: "bigint" }).notNull(),
    priceT0: doublePrecision("price_t0"),
    priceT1m: doublePrecision("price_t_1m"),
    priceT5m: doublePrecision("price_t_5m"),
    priceT30m: doublePrecision("price_t_30m"),
    priceT1h: doublePrecision("price_t_1h"),
    priceT6h: doublePrecision("price_t_6h"),
    maxGainPct: doublePrecision("max_gain_pct"),
    maxDrawdownPct: doublePrecision("max_drawdown_pct"),
    graduatedWithin24h: varchar("graduated_within_24h", { length: 8 }),
    extras: jsonb("extras"),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    src: index("trade_outcomes_src_idx").on(t.source, t.tradeId),
  }),
);

export const signalOutcomes = pgTable(
  "signal_outcomes",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    mint: varchar("mint", { length: 64 }).notNull(),
    decisionId: bigint("decision_id", { mode: "bigint" }),
    ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
    actionEmitted: varchar("action_emitted", { length: 24 }).notNull(),
    confluenceScore: doublePrecision("confluence_score"),
    priceT0: doublePrecision("price_t0"),
    priceT1m: doublePrecision("price_t_1m"),
    priceT5m: doublePrecision("price_t_5m"),
    priceT30m: doublePrecision("price_t_30m"),
    priceT1h: doublePrecision("price_t_1h"),
    graduatedWithin24h: varchar("graduated_within_24h", { length: 8 }),
    extras: jsonb("extras"),
  },
  (t) => ({
    mint: index("signal_outcomes_mint_idx").on(t.mint),
  }),
);
