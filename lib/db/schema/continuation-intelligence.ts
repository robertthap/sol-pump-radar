import {
  pgTable,
  bigserial,
  varchar,
  timestamp,
  doublePrecision,
  integer,
  jsonb,
  index,
} from "drizzle-orm/pg-core";

export const mintRegistry = pgTable(
  "mint_registry",
  {
    mint: varchar("mint", { length: 64 }).primaryKey(),
    symbol: varchar("symbol", { length: 32 }),
    name: varchar("name", { length: 128 }),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    engineOrigin: varchar("engine_origin", { length: 24 }).notNull().default("discovery"),
    lifecycleState: varchar("lifecycle_state", { length: 24 }).notNull().default("unknown"),
    migrationAt: timestamp("migration_at", { withTimezone: true }),
    primaryPool: varchar("primary_pool", { length: 128 }),
    primaryDex: varchar("primary_dex", { length: 32 }),
    poolCount: integer("pool_count").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    updatedAt: index("mint_registry_updated_at_idx").on(t.updatedAt),
  }),
);

export const poolRegistry = pgTable(
  "pool_registry",
  {
    mint: varchar("mint", { length: 64 }).notNull(),
    pairAddress: varchar("pair_address", { length: 128 }).notNull(),
    dexId: varchar("dex_id", { length: 32 }),
    liqUsd: doublePrecision("liq_usd"),
    priceUsd: doublePrecision("price_usd"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: index("pool_registry_pk").on(t.mint, t.pairAddress),
    mint: index("pool_registry_mint_idx").on(t.mint),
  }),
);

export const dexFeatures = pgTable(
  "dex_features",
  {
    mint: varchar("mint", { length: 64 }).primaryKey(),
    volM5: doublePrecision("vol_m5"),
    volH1: doublePrecision("vol_h1"),
    volH24: doublePrecision("vol_h24"),
    volAcceleration: doublePrecision("vol_acceleration"),
    liqUsd: doublePrecision("liq_usd"),
    liqGrowthProxy: doublePrecision("liq_growth_proxy"),
    buysM5: integer("buys_m5"),
    sellsM5: integer("sells_m5"),
    buySellRatio: doublePrecision("buy_sell_ratio"),
    poolCount: integer("pool_count"),
    trendRank: integer("trend_rank"),
    priceChangeM5: doublePrecision("price_change_m5"),
    priceChangeH1: doublePrecision("price_change_h1"),
    priceChangeH24: doublePrecision("price_change_h24"),
    pairCreatedAt: timestamp("pair_created_at", { withTimezone: true }),
    migrationAgeHours: doublePrecision("migration_age_hours"),
    continuationScore: doublePrecision("continuation_score"),
    exhaustionRisk: doublePrecision("exhaustion_risk"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    updatedAt: index("dex_features_updated_at_idx").on(t.updatedAt),
    contScore: index("dex_features_cont_score_idx").on(t.continuationScore),
  }),
);

export const continuationCandidates = pgTable(
  "continuation_candidates",
  {
    mint: varchar("mint", { length: 64 }).primaryKey(),
    continuationScore: doublePrecision("continuation_score").notNull().default(0),
    trendRank: integer("trend_rank"),
    source: varchar("source", { length: 32 }).notNull().default("dex"),
    dexH24Pct: doublePrecision("dex_h24_pct"),
    liqUsd: doublePrecision("liq_usd"),
    alertAction: varchar("alert_action", { length: 32 }),
    momentumState: varchar("momentum_state", { length: 32 }),
    rankPercentile: doublePrecision("rank_percentile"),
    volRankPercentile: doublePrecision("vol_rank_percentile"),
    liqRankPercentile: doublePrecision("liq_rank_percentile"),
    rankVelocity: doublePrecision("rank_velocity"),
    stateConfidence: doublePrecision("state_confidence"),
    pBreakout: doublePrecision("p_breakout"),
    pExhaustion: doublePrecision("p_exhaustion"),
    pContinuation: doublePrecision("p_continuation"),
    engineBAction: varchar("engine_b_action", { length: 32 }),
    engineBJson: jsonb("engine_b_json"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    updatedAt: index("continuation_candidates_updated_at_idx").on(t.updatedAt),
    score: index("continuation_candidates_score_idx").on(t.continuationScore),
  }),
);

export const decisionTrace = pgTable(
  "decision_trace",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
    mint: varchar("mint", { length: 64 }).notNull(),
    stage: varchar("stage", { length: 48 }).notNull(),
    engine: varchar("engine", { length: 16 }).notNull().default("B"),
    action: varchar("action", { length: 32 }),
    reason: varchar("reason", { length: 2048 }),
    vetoes: jsonb("vetoes"),
    confidence: doublePrecision("confidence"),
    featureSnapshot: jsonb("feature_snapshot"),
  },
  (t) => ({
    mintTs: index("decision_trace_mint_ts_idx").on(t.mint, t.ts),
    stage: index("decision_trace_stage_idx").on(t.stage),
    ts: index("decision_trace_ts_idx").on(t.ts),
  }),
);

export const continuationEvents = pgTable(
  "continuation_events",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    mint: varchar("mint", { length: 64 }).notNull(),
    ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
    kind: varchar("kind", { length: 48 }).notNull(),
    payload: jsonb("payload"),
  },
  (t) => ({
    mintTs: index("continuation_events_mint_ts_idx").on(t.mint, t.ts),
  }),
);

export const engineBTraces = pgTable(
  "engine_b_traces",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    mint: varchar("mint", { length: 64 }).notNull(),
    ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
    trace: jsonb("trace").notNull(),
    action: varchar("action", { length: 32 }),
    score: doublePrecision("score"),
    engineBVersion: varchar("engine_b_version", { length: 16 }).notNull().default("b1"),
  },
  (t) => ({
    mintTs: index("engine_b_traces_mint_ts_idx").on(t.mint, t.ts),
    ts: index("engine_b_traces_ts_idx").on(t.ts),
  }),
);

export const normalizedSnapshots = pgTable(
  "normalized_snapshots",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    mint: varchar("mint", { length: 64 }).notNull(),
    ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
    snapshot: jsonb("snapshot").notNull(),
  },
  (t) => ({
    mintTs: index("normalized_snapshots_mint_ts_idx").on(t.mint, t.ts),
  }),
);
