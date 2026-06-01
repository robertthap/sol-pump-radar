import {
  pgTable,
  bigserial,
  varchar,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";

/**
 * One row per "Auto-Trade" session the user starts. Only one row should be
 * status='active' at any given time. The auto-trader worker reads the active
 * row each tick to decide whether to drive trades.
 */
export const autoSessions = pgTable(
  "auto_sessions",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    stoppedAt: timestamp("stopped_at", { withTimezone: true }),
    status: varchar("status", { length: 16 }).notNull().default("active"),
    mode: varchar("mode", { length: 8 }).notNull().default("paper"),
    /**
     * params:
     *   sizeSol           - per-trade size
     *   takeProfitPct     - 0.5 = +50%
     *   stopLossPct       - 0.3 = -30%
     *   maxConcurrent     - max simultaneous open positions
     *   maxDailyLossSol   - circuit-break the session if today's losses exceed this
     *   signalStrictness  - 'strong' | 'strong_and_moderate'
     *   useLearnedAvoids  - bool, defaults true
     *   maxHoldMinutes    - timeout exit
     */
    params: jsonb("params").notNull(),
    /**
     * stats updated by the worker:
     *   tradesOpened, tradesClosed, wins, losses,
     *   realizedPnlSol, lastErrorMessage, lastTickAt
     */
    stats: jsonb("stats").notNull().default({}),
    stopReason: varchar("stop_reason", { length: 128 }),
  },
  (t) => ({
    status: index("auto_sessions_status_idx").on(t.status),
    started: index("auto_sessions_started_at_idx").on(t.startedAt),
  }),
);

export type AutoSession = typeof autoSessions.$inferSelect;
export type NewAutoSession = typeof autoSessions.$inferInsert;
