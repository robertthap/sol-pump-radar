import {
  pgTable,
  bigserial,
  varchar,
  text,
  timestamp,
  doublePrecision,
  integer,
  jsonb,
  index,
} from "drizzle-orm/pg-core";

/** Snapshot of entry context for losing trades — feeds pattern mining. */
export const lossPostmortems = pgTable(
  "loss_postmortems",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
    source: varchar("source", { length: 16 }).notNull(),
    tradeId: bigserial("trade_id", { mode: "bigint" }).notNull(),
    mint: varchar("mint", { length: 64 }).notNull(),
    pnlSol: doublePrecision("pnl_sol").notNull(),
    pnlPct: doublePrecision("pnl_pct"),
    exitReason: varchar("exit_reason", { length: 64 }),
    entryAction: varchar("entry_action", { length: 32 }),
    features: jsonb("features").notNull(),
    modulesAtEntry: jsonb("modules_at_entry"),
  },
  (t) => ({
    trade: index("loss_postmortems_trade_idx").on(t.source, t.tradeId),
    mint: index("loss_postmortems_mint_idx").on(t.mint),
    recorded: index("loss_postmortems_recorded_idx").on(t.recordedAt),
  }),
);

/** Auto-derived avoid filters from loss patterns. */
export const learnedRules = pgTable(
  "learned_rules",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    featureKey: varchar("feature_key", { length: 64 }).notNull(),
    operator: varchar("operator", { length: 8 }).notNull(),
    threshold: doublePrecision("threshold").notNull(),
    sampleN: integer("sample_n").notNull(),
    lossRate: doublePrecision("loss_rate").notNull(),
    status: varchar("status", { length: 16 }).notNull().default("proposed"),
    reason: text("reason").notNull(),
    metrics: jsonb("metrics"),
  },
  (t) => ({
    status: index("learned_rules_status_idx").on(t.status),
    feature: index("learned_rules_feature_idx").on(t.featureKey),
  }),
);
