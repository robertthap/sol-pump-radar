import {
  pgTable,
  bigserial,
  varchar,
  timestamp,
  bigint,
  index,
} from "drizzle-orm/pg-core";

export const walletEdges = pgTable(
  "wallet_edges",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    fromWallet: varchar("from_wallet", { length: 64 }).notNull(),
    toWallet: varchar("to_wallet", { length: 64 }).notNull(),
    lamports: bigint("lamports", { mode: "bigint" }).notNull(),
    slot: bigint("slot", { mode: "bigint" }).notNull(),
    signature: varchar("signature", { length: 96 }).notNull(),
    ts: timestamp("ts", { withTimezone: true }).notNull(),
    edgeType: varchar("edge_type", { length: 24 }).notNull(),
  },
  (t) => ({
    from: index("wallet_edges_from_idx").on(t.fromWallet),
    to: index("wallet_edges_to_idx").on(t.toWallet),
    sig: index("wallet_edges_sig_idx").on(t.signature),
  }),
);
