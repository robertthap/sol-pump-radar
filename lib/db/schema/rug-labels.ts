import {
  pgTable,
  varchar,
  timestamp,
  doublePrecision,
  integer,
  jsonb,
  index,
} from "drizzle-orm/pg-core";

/**
 * Inactivity-based rug labels — implements the labeling procedure from
 * Kalacheva et al. (2026, §4.2): a token is labeled rugged if it shows
 * no swap activity for ≥ inactivity_seconds before label_at. Their study
 * found that a 1h gap on Uniswap V2 reliably correlated with permanent
 * inactivity (98.6% to 99.9%); on pump.fun curves are faster, so we use
 * a shorter default window.
 *
 * One row per (mint, label_at_window). The labeler upserts so the same
 * mint can be re-labeled if it briefly resurrects and then dies again.
 */
export const rugLabels = pgTable(
  "rug_labels",
  {
    mint: varchar("mint", { length: 64 }).primaryKey(),
    label: varchar("label", { length: 16 }).notNull(),
    labeledAt: timestamp("labeled_at", { withTimezone: true }).notNull().defaultNow(),
    lastEventAt: timestamp("last_event_at", { withTimezone: true }),
    inactivitySeconds: integer("inactivity_seconds").notNull(),
    peakVSol: doublePrecision("peak_v_sol"),
    finalVSol: doublePrecision("final_v_sol"),
    drawdown: doublePrecision("drawdown"),
    trades: integer("trades"),
    uniqueBuyers: integer("unique_buyers"),
    reason: varchar("reason", { length: 200 }),
    evidence: jsonb("evidence"),
  },
  (t) => ({
    label: index("rug_labels_label_idx").on(t.label),
    labeled: index("rug_labels_labeled_at_idx").on(t.labeledAt),
  }),
);

export type RugLabelRow = typeof rugLabels.$inferSelect;
