import {
  pgTable,
  bigserial,
  bigint,
  integer,
  varchar,
  timestamp,
  doublePrecision,
  boolean,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Upgrade-plan Phase 1 — the measurement backbone (created in
 * drizzle/0020_measurement_backbone.sql; this is the typed mirror for repos).
 *
 * feature_snapshots is IMMUTABLE: a point-in-time feature vector + engine output.
 * outcome_labels matures asynchronously and is the ONLY place forward values live,
 * so a future value can never leak into a feature row (point-in-time correctness).
 */
export const featureSnapshots = pgTable(
  "feature_snapshots",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    mint: varchar("mint", { length: 64 }).notNull(),
    ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
    /** 'universe' | 'control' | 'shadow' */
    sampleSource: varchar("sample_source", { length: 16 }).notNull().default("universe"),
    features: jsonb("features").notNull(),
    engineOutputs: jsonb("engine_outputs"),
    staleFlags: jsonb("stale_flags"),
    decisionId: bigint("decision_id", { mode: "bigint" }),
    refVSol: doublePrecision("ref_v_sol"),
    refMcapUsd: doublePrecision("ref_mcap_usd"),
  },
  (t) => ({
    mintTs: index("feature_snapshots_mint_ts_idx").on(t.mint, t.ts),
    source: index("feature_snapshots_source_idx").on(t.sampleSource),
    ts: index("feature_snapshots_ts_idx").on(t.ts),
  }),
);

export const outcomeLabels = pgTable(
  "outcome_labels",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    snapshotId: bigint("snapshot_id", { mode: "bigint" }).notNull(),
    mint: varchar("mint", { length: 64 }).notNull(),
    baseTs: timestamp("base_ts", { withTimezone: true }).notNull(),
    ret5m: doublePrecision("ret_5m"),
    ret30m: doublePrecision("ret_30m"),
    ret1h: doublePrecision("ret_1h"),
    ret6h: doublePrecision("ret_6h"),
    maxGainPct: doublePrecision("max_gain_pct"),
    maxDrawdownPct: doublePrecision("max_drawdown_pct"),
    isRug: boolean("is_rug"),
    isBreakout: boolean("is_breakout"),
    timeToPeakSec: doublePrecision("time_to_peak_sec"),
    timeToGraduationSec: doublePrecision("time_to_graduation_sec"),
    horizonsComplete: boolean("horizons_complete").notNull().default(false),
    labelReadyAt: timestamp("label_ready_at", { withTimezone: true }).notNull().defaultNow(),
    // T1.1 — set to 'gap' when an unrecovered ingest_gap overlapped the
    // snapshot's horizon, so we never silently compute a label over incomplete
    // event data. NULL means the label was computed normally (or is pending).
    blockedReason: varchar("blocked_reason", { length: 32 }),
  },
  (t) => ({
    snapshotUq: uniqueIndex("outcome_labels_snapshot_uq").on(t.snapshotId),
    mint: index("outcome_labels_mint_idx").on(t.mint),
    complete: index("outcome_labels_complete_idx").on(t.horizonsComplete),
  }),
);

/** B2: one row per `pnpm eval-paper` run — the OOS trend across the Phase 2 wait. */
export const evalRuns = pgTable(
  "eval_runs",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    ranAt: timestamp("ran_at", { withTimezone: true }).notNull().defaultNow(),
    windowStart: timestamp("window_start", { withTimezone: true }),
    windowEnd: timestamp("window_end", { withTimezone: true }),
    trades: integer("trades").notNull().default(0),
    winRate: doublePrecision("win_rate"),
    meanRet: doublePrecision("mean_ret"),
    oosSharpe: doublePrecision("oos_sharpe"),
    tailLossP95: doublePrecision("tail_loss_p95"),
    totalPnlSol: doublePrecision("total_pnl_sol"),
    byReason: jsonb("by_reason"),
    byAge: jsonb("by_age"),
  },
  (t) => ({
    ranAt: index("eval_runs_ran_at_idx").on(t.ranAt),
  }),
);

export type FeatureSnapshotRow = typeof featureSnapshots.$inferSelect;
export type NewFeatureSnapshot = typeof featureSnapshots.$inferInsert;
export type OutcomeLabelRow = typeof outcomeLabels.$inferSelect;
export type EvalRunRow = typeof evalRuns.$inferSelect;
