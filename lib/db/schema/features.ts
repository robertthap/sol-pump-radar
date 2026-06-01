import {
  pgTable,
  varchar,
  timestamp,
  doublePrecision,
  integer,
  jsonb,
  index,
} from "drizzle-orm/pg-core";

export const tokenFeatures = pgTable(
  "token_features",
  {
    mint: varchar("mint", { length: 64 }).notNull(),
    ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
    vSol: doublePrecision("v_sol"),
    curveProgress: doublePrecision("curve_progress"),
    curveVelocity5m: doublePrecision("curve_velocity_5m"),
    tradesPerSol: doublePrecision("trades_per_sol"),
    buyVol5m: doublePrecision("buy_vol_5m"),
    sellVol5m: doublePrecision("sell_vol_5m"),
    buys5m: integer("buys_5m"),
    sells5m: integer("sells_5m"),
    ofi1m: doublePrecision("ofi_1m"),
    ofi5m: doublePrecision("ofi_5m"),
    ofi15m: doublePrecision("ofi_15m"),
    holderTop1Pct: doublePrecision("holder_top1_pct"),
    holderTop10Pct: doublePrecision("holder_top10_pct"),
    uniqueBuyers5m: integer("unique_buyers_5m"),
    holderGrowth5m: doublePrecision("holder_growth_5m"),
    botRatio: doublePrecision("bot_ratio"),
    insiderNetSol5m: doublePrecision("insider_net_sol_5m"),
    successfulTraderCount: integer("successful_trader_count"),
    momentumScore: doublePrecision("momentum_score"),
    gradScore: doublePrecision("grad_score"),
    rugScore: doublePrecision("rug_score"),
    creatorScore: doublePrecision("creator_score"),
    holderHealth: doublePrecision("holder_health"),
    washScore: doublePrecision("wash_score"),
    clusterQuality: doublePrecision("cluster_quality"),
    confluenceScore: doublePrecision("confluence_score"),
    metaProbGoodTrade: doublePrecision("meta_prob_good_trade"),
    calibratedGradProb: doublePrecision("calibrated_grad_prob"),
    extras: jsonb("extras"),
  },
  (t) => ({
    mintTs: index("token_features_mint_ts_idx").on(t.mint, t.ts),
    confluence: index("token_features_confluence_idx").on(t.confluenceScore),
  }),
);

export const walletFeatures = pgTable(
  "wallet_features",
  {
    wallet: varchar("wallet", { length: 64 }).primaryKey(),
    firstSeen: timestamp("first_seen", { withTimezone: true }),
    lastSeen: timestamp("last_seen", { withTimezone: true }),
    tradeCount: integer("trade_count").notNull().default(0),
    realizedPnlSol: doublePrecision("realized_pnl_sol").notNull().default(0),
    winRate30d: doublePrecision("win_rate_30d"),
    avgEntrySlotOffset: doublePrecision("avg_entry_slot_offset"),
    isBotScore: doublePrecision("is_bot_score"),
    isSniperScore: doublePrecision("is_sniper_score"),
    insiderScore: doublePrecision("insider_score"),
    clusterId: varchar("cluster_id", { length: 64 }),
    labels: jsonb("labels"),
  },
  (t) => ({
    insider: index("wallet_features_insider_idx").on(t.insiderScore),
    cluster: index("wallet_features_cluster_idx").on(t.clusterId),
  }),
);

export const creatorFeatures = pgTable(
  "creator_features",
  {
    creator: varchar("creator", { length: 64 }).primaryKey(),
    launches: integer("launches").notNull().default(0),
    graduations: integer("graduations").notNull().default(0),
    rugs: integer("rugs").notNull().default(0),
    medianTimeToDumpSec: doublePrecision("median_time_to_dump_sec"),
    spamScore: doublePrecision("spam_score"),
    creatorScore: doublePrecision("creator_score"),
    lastUpdated: timestamp("last_updated", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    creatorScore: index("creator_features_score_idx").on(t.creatorScore),
  }),
);
