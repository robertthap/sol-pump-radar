import {
  pgTable,
  bigserial,
  varchar,
  text,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Local trading wallet. v1 supports a single wallet (label='main'). The secret
 * key never leaves the host — it is AES-256-GCM encrypted with a scrypt-derived
 * key from the user's passphrase and persisted to Postgres alongside the rest
 * of the local state.
 */
export const walletsLocal = pgTable(
  "wallets_local",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    label: varchar("label", { length: 64 }).notNull().default("main"),
    publicKey: varchar("public_key", { length: 64 }).notNull(),
    encryptedSecret: text("encrypted_secret").notNull(),
    source: varchar("source", { length: 16 }).notNull(),
  },
  (t) => ({
    pubkey: uniqueIndex("wallets_local_pubkey_uq").on(t.publicKey),
    label: index("wallets_local_label_idx").on(t.label),
  }),
);

export type WalletLocal = typeof walletsLocal.$inferSelect;
export type NewWalletLocal = typeof walletsLocal.$inferInsert;
