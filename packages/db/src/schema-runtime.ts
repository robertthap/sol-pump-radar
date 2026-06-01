import {
  pgTable,
  bigserial,
  bigint,
  smallint,
  integer,
  varchar,
  timestamp,
  jsonb,
  doublePrecision,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const domainEvents = pgTable(
  "domain_events",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    type: varchar("type", { length: 64 }).notNull(),
    payload: jsonb("payload").notNull().default(sql`'{}'::jsonb`),
    dedupeKey: varchar("dedupe_key", { length: 256 }),
    correlationId: varchar("correlation_id", { length: 64 }),
    sessionId: bigint("session_id", { mode: "bigint" }),
  },
  (t) => ({
    dedupeUq: uniqueIndex("domain_events_dedupe_key_uq").on(t.dedupeKey),
    sessionIx: index("domain_events_session_idx").on(t.sessionId),
    correlationIx: index("domain_events_correlation_idx").on(t.correlationId),
  }),
);

export const ingestFacts = pgTable(
  "ingest_facts",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    signature: varchar("signature", { length: 96 }).notNull(),
    mint: varchar("mint", { length: 64 }),
    raw: jsonb("raw").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    dedupeKey: varchar("dedupe_key", { length: 256 }).notNull(),
  },
  (t) => ({
    sigIx: index("ingest_facts_signature_idx").on(t.signature),
    mintCreated: index("ingest_facts_mint_created_idx").on(t.mint, t.createdAt),
    dedupeUq: uniqueIndex("ingest_facts_dedupe_key_uq").on(t.dedupeKey),
  }),
);

export const signals = pgTable(
  "signals",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    mint: varchar("mint", { length: 64 }).notNull(),
    score: doublePrecision("score").notNull(),
    reason: varchar("reason", { length: 512 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    mintScore: index("signals_mint_score_idx").on(t.mint, t.score),
  }),
);

export const tradesFsm = pgTable(
  "trades_fsm",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    mint: varchar("mint", { length: 64 }).notNull(),
    state: varchar("state", { length: 16 }).notNull().default("INTENT"),
    meta: jsonb("meta"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    stateIx: index("trades_fsm_state_idx").on(t.state),
  }),
);

export const paperSessions = pgTable(
  "paper_sessions",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    startingBalanceSol: doublePrecision("starting_balance_sol").notNull(),
    endingBalanceSol: doublePrecision("ending_balance_sol"),
    resetReason: varchar("reset_reason", { length: 256 }),
  },
);

export const paperPortfolio = pgTable(
  "paper_portfolio",
  {
    id: smallint("id").primaryKey(),
    sessionId: bigint("session_id", { mode: "bigint" }).notNull(),
    balanceSol: doublePrecision("balance_sol").notNull(),
    equitySol: doublePrecision("equity_sol").notNull(),
    realizedPnlSol: doublePrecision("realized_pnl_sol").notNull().default(0),
    unrealizedPnlSol: doublePrecision("unrealized_pnl_sol").notNull().default(0),
    peakEquitySol: doublePrecision("peak_equity_sol").notNull(),
    totalTrades: integer("total_trades").notNull().default(0),
    wins: integer("wins").notNull().default(0),
    losses: integer("losses").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
);

export const paperPositions = pgTable(
  "paper_positions",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    sessionId: bigint("session_id", { mode: "bigint" }).notNull(),
    correlationId: varchar("correlation_id", { length: 64 }),
    mint: varchar("mint", { length: 64 }).notNull(),
    symbol: varchar("symbol", { length: 32 }),
    side: varchar("side", { length: 8 }).notNull().default("BUY"),
    state: varchar("state", { length: 16 }).notNull().default("INTENT"),
    entryPrice: doublePrecision("entry_price").notNull(),
    exitPrice: doublePrecision("exit_price"),
    quantity: doublePrecision("quantity").notNull(),
    notionalSol: doublePrecision("notional_sol").notNull(),
    currentPrice: doublePrecision("current_price"),
    realizedPnlSol: doublePrecision("realized_pnl_sol"),
    unrealizedPnlSol: doublePrecision("unrealized_pnl_sol"),
    stopLoss: doublePrecision("stop_loss"),
    takeProfit: doublePrecision("take_profit"),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closeReason: varchar("close_reason", { length: 32 }),
    /** Snapshotted feature vector at entry (signal state, scores, etc). */
    entryFeatures: jsonb("entry_features"),
    /** Snapshot of which strategy modules contributed at entry. */
    modulesAtEntry: jsonb("modules_at_entry"),
    /** TP1 partial-close support so the new engine matches legacy behavior. */
    tp1Fraction: doublePrecision("tp1_fraction"),
    tp1RealizedSol: doublePrecision("tp1_realized_sol"),
    tp1AtPrice: doublePrecision("tp1_at_price"),
    tp1AtTs: timestamp("tp1_at_ts", { withTimezone: true }),
    /** Decision id from auto-trader for cross-referencing (nullable). */
    decisionId: bigint("decision_id", { mode: "bigint" }),
  },
  (t) => ({
    openIx: index("paper_positions_open_idx").on(t.state, t.openedAt),
    sessionIx: index("paper_positions_session_idx").on(t.sessionId, t.openedAt),
    mintIx: index("paper_positions_mint_idx").on(t.mint),
    decisionIx: index("paper_positions_decision_idx").on(t.decisionId),
  }),
);

export const paperTradeFills = pgTable(
  "paper_trade_fills",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    positionId: bigint("position_id", { mode: "bigint" }).notNull(),
    fillType: varchar("fill_type", { length: 16 }).notNull(),
    fillPrice: doublePrecision("fill_price").notNull(),
    quantity: doublePrecision("quantity").notNull(),
    notionalSol: doublePrecision("notional_sol").notNull(),
    slippageBps: integer("slippage_bps").notNull().default(0),
    feeSol: doublePrecision("fee_sol").notNull().default(0),
    latencyMs: integer("latency_ms").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    positionIx: index("paper_trade_fills_position_idx").on(t.positionId, t.createdAt),
  }),
);

export const runtimeSchema = {
  domainEvents,
  ingestFacts,
  signals,
  tradesFsm,
  paperSessions,
  paperPortfolio,
  paperPositions,
  paperTradeFills,
};
