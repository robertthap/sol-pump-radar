import {
  pgTable,
  bigserial,
  integer,
  doublePrecision,
  boolean,
  jsonb,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

/**
 * T1.3 — drift / meta-shift metrics. One row per drift-monitor tick. Computes
 * PSI of the core feature vector (recent window vs the baseline window) on the
 * UNBIASED universe sampler (feature_snapshots, sample_source='universe'), plus
 * the positive-label base rate over time. The kill-gate (SYSTEM_DESIGN §8) reads
 * `meta_shift` / `max_psi` to verify its "window spanned ≥1 meta shift" condition.
 */
export const driftMetrics = pgTable(
  "drift_metrics",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    windowEnd: timestamp("window_end", { withTimezone: true }).notNull(),
    baselineStart: timestamp("baseline_start", { withTimezone: true }).notNull(),
    baselineEnd: timestamp("baseline_end", { withTimezone: true }).notNull(),
    /** Per-feature PSI: { dex_vol_m5: 0.04, dex_liq_usd: 0.31, ... }. */
    psiByFeature: jsonb("psi_by_feature").notNull(),
    maxPsi: doublePrecision("max_psi").notNull(),
    metaShift: boolean("meta_shift").notNull().default(false),
    /** Positive-label base rate in the current window (winners / labeled), if computable. */
    positiveLabelRate: doublePrecision("positive_label_rate"),
    baselineN: integer("baseline_n").notNull().default(0),
    currentN: integer("current_n").notNull().default(0),
  },
  (t) => ({
    computedAt: index("drift_metrics_computed_at_idx").on(t.computedAt),
  }),
);

export type DriftMetricRow = typeof driftMetrics.$inferSelect;
export type NewDriftMetric = typeof driftMetrics.$inferInsert;
