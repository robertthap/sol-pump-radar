import {
  pgTable,
  bigserial,
  varchar,
  timestamp,
  doublePrecision,
  jsonb,
  index,
} from "drizzle-orm/pg-core";

export const decisionLog = pgTable(
  "decision_log",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
    mint: varchar("mint", { length: 64 }).notNull(),
    action: varchar("action", { length: 24 }).notNull(),
    confluenceScore: doublePrecision("confluence_score").notNull(),
    threshold: doublePrecision("threshold").notNull(),
    modulesFired: jsonb("modules_fired"),
    moduleScores: jsonb("module_scores"),
    vetoes: jsonb("vetoes"),
    reasonHuman: varchar("reason_human", { length: 512 }),
    mode: varchar("mode", { length: 8 }).notNull(),
    executed: varchar("executed", { length: 16 }).notNull().default("pending"),
    executorReason: varchar("executor_reason", { length: 128 }),
  },
  (t) => ({
    mintTs: index("decision_log_mint_ts_idx").on(t.mint, t.ts),
    action: index("decision_log_action_idx").on(t.action),
  }),
);

export const tunerChanges = pgTable("tuner_changes", {
  id: bigserial("id", { mode: "bigint" }).primaryKey(),
  ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
  reason: varchar("reason", { length: 128 }).notNull(),
  diff: jsonb("diff").notNull(),
  metricsBefore: jsonb("metrics_before"),
  metricsAfter: jsonb("metrics_after"),
  reverted: varchar("reverted", { length: 8 }).notNull().default("no"),
});
