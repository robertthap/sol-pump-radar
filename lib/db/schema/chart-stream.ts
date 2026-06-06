import {
  pgTable,
  text,
  integer,
  bigint,
  bigserial,
  timestamp,
  doublePrecision,
  jsonb,
  index,
  uniqueIndex,
  primaryKey,
} from "drizzle-orm/pg-core";

export const chartStreamState = pgTable("chart_stream_state", {
  mint: text("mint").primaryKey(),
  epoch: integer("epoch").notNull().default(1),
  lastTradeId: bigint("last_trade_id", { mode: "bigint" }).notNull().default(0n),
  lastSeq: integer("last_seq").notNull().default(0),
  graduationAt: timestamp("graduation_at", { withTimezone: true }),
  regime: text("regime").notNull().default("bonding_curve"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const mintDexQuotes = pgTable(
  "mint_dex_quotes",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    mint: text("mint").notNull(),
    ts: timestamp("ts", { withTimezone: true }).notNull(),
    priceUsd: doublePrecision("price_usd").notNull(),
    mcapUsd: doublePrecision("mcap_usd"),
    source: text("source").notNull(),
  },
  (t) => ({
    mintTsSourceUq: uniqueIndex("mint_dex_quotes_mint_ts_source_uq").on(t.mint, t.ts, t.source),
    mintTsIdx: index("mint_dex_quotes_mint_ts_idx").on(t.mint, t.ts),
  }),
);

export const chartCandleCheckpoints = pgTable(
  "chart_candle_checkpoints",
  {
    mint: text("mint").notNull(),
    tf: text("tf").notNull(),
    epoch: integer("epoch").notNull(),
    lastTradeId: bigint("last_trade_id", { mode: "bigint" }).notNull(),
    candlesJson: jsonb("candles_json").notNull(),
    checksum: text("checksum"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.mint, t.tf] }),
  }),
);
