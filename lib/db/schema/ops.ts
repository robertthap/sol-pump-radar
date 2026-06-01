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

export const rpcHealth = pgTable("rpc_health", {
  endpoint: varchar("endpoint", { length: 256 }).primaryKey(),
  kind: varchar("kind", { length: 8 }).notNull(),
  lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }).notNull().defaultNow(),
  p50LatencyMs: doublePrecision("p50_latency_ms"),
  p95LatencyMs: doublePrecision("p95_latency_ms"),
  errorRate5m: doublePrecision("error_rate_5m"),
  rateLimitedCount: integer("rate_limited_count").notNull().default(0),
  cooldownUntil: timestamp("cooldown_until", { withTimezone: true }),
  isHealthy: varchar("is_healthy", { length: 8 }).notNull().default("unknown"),
});

export const deadLetters = pgTable(
  "dead_letters",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
    queue: varchar("queue", { length: 64 }).notNull(),
    jobName: varchar("job_name", { length: 64 }).notNull(),
    attempts: integer("attempts").notNull(),
    error: varchar("error", { length: 512 }),
    payload: jsonb("payload"),
  },
  (t) => ({
    queueTs: index("dead_letters_queue_ts_idx").on(t.queue, t.ts),
  }),
);
