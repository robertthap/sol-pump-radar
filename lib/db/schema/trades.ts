import {
  pgTable,
  bigserial,
  varchar,
  text,
  timestamp,
  doublePrecision,
  boolean,
  jsonb,
  index,
} from "drizzle-orm/pg-core";

const tradeColumns = {
  id: bigserial("id", { mode: "bigint" }).primaryKey(),
  mint: varchar("mint", { length: 64 }).notNull(),
  side: varchar("side", { length: 8 }).notNull(),
  status: varchar("status", { length: 16 }).notNull().default("open"),
  sizeSol: doublePrecision("size_sol").notNull(),
  entryPrice: doublePrecision("entry_price"),
  exitPrice: doublePrecision("exit_price"),
  feesSol: doublePrecision("fees_sol").notNull().default(0),
  slippageBps: doublePrecision("slippage_bps"),
  pnlSol: doublePrecision("pnl_sol"),
  exitReason: varchar("exit_reason", { length: 64 }),
  entryFeatures: jsonb("entry_features"),
  modulesAtEntry: jsonb("modules_at_entry"),
  openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
  closedAt: timestamp("closed_at", { withTimezone: true }),
};

export const paperTrades = pgTable("paper_trades", { ...tradeColumns }, (t) => ({
  mint: index("paper_trades_mint_idx").on(t.mint),
  closedAt: index("paper_trades_closed_at_idx").on(t.closedAt),
}));

export const liveTrades = pgTable(
  "live_trades",
  {
    ...tradeColumns,
    network: varchar("network", { length: 16 }).notNull().default("mainnet"),
    buySignature: varchar("buy_signature", { length: 96 }),
    sellSignature: varchar("sell_signature", { length: 96 }),
    txSignatureOpen: varchar("tx_signature_open", { length: 96 }),
    txSignatureClose: varchar("tx_signature_close", { length: 96 }),
    dryRun: boolean("dry_run").notNull().default(true),
    errorMessage: text("error_message"),
    route: varchar("route", { length: 16 }),
    sessionId: varchar("session_id", { length: 32 }),
  },
  (t) => ({
    mint: index("live_trades_mint_idx").on(t.mint),
    closedAt: index("live_trades_closed_at_idx").on(t.closedAt),
    openedAt: index("live_trades_opened_at_idx").on(t.openedAt),
    session: index("live_trades_session_idx").on(t.sessionId),
  }),
);
