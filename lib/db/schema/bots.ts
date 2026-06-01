import {
  pgTable,
  varchar,
  bigint,
  integer,
  doublePrecision,
  boolean,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";

/**
 * Per-mint manipulation flags following Luo et al. (WWW '26)
 * "Resisting Manipulative Bots in Meme Coin Copy Trading".
 *
 *  - hasBundle: ≥1 non-creator BUY in the launch block (Alg. 1)
 *  - hasSniper: ≥1 non-creator BUY within first K=5 blocks/slots after launch (Alg. 2)
 *  - hasBumpBot: ≥1 wallet with flip-score α = F / (|ΔP|+ε) ≥ ξ=50 (Alg. 3)
 *  - mechanicalUptrend: candlestick-pattern proxy for gradual-bundle dump signature (§4.3.5)
 */
export const mintBotFlags = pgTable(
  "mint_bot_flags",
  {
    mint: varchar("mint", { length: 64 }).primaryKey(),
    creator: varchar("creator", { length: 64 }),
    launchSlot: bigint("launch_slot", { mode: "bigint" }),
    launchTs: timestamp("launch_ts", { withTimezone: true }),
    hasBundle: boolean("has_bundle").notNull().default(false),
    hasSniper: boolean("has_sniper").notNull().default(false),
    hasBumpBot: boolean("has_bump_bot").notNull().default(false),
    mechanicalUptrend: boolean("mechanical_uptrend").notNull().default(false),
    bundleWalletCount: integer("bundle_wallet_count").notNull().default(0),
    sniperWalletCount: integer("sniper_wallet_count").notNull().default(0),
    bumpWalletCount: integer("bump_wallet_count").notNull().default(0),
    /** crude on-chain attention proxy: count of distinct buyer wallets in first 5 minutes */
    earlyUniqueBuyers: integer("early_unique_buyers").notNull().default(0),
    detectedAt: timestamp("detected_at", { withTimezone: true }).notNull().defaultNow(),
    raw: jsonb("raw"),
  },
  (t) => ({
    detected: index("mint_bot_flags_detected_idx").on(t.detectedAt),
    bundleIdx: index("mint_bot_flags_bundle_idx").on(t.hasBundle),
  }),
);

/**
 * Per-wallet rolling stats used by the "Wallet agent" gate from the paper:
 *   - statistical significance: t = avgReturn / (std/sqrt(n))
 *   - profitability: avgReturn
 *   - robustness: std, recent horizon returns
 *   - experience: tradeCount, distinctMints
 *
 * Returns are computed from per-mint realized PnL approximations:
 *   for each (wallet, mint) pair we track sumSolBuys / sumSolSells.
 *   When tokensHeld≈0, realized = sumSolSells/sumSolBuys − 1.
 */
export const walletProfiles = pgTable(
  "wallet_profiles",
  {
    wallet: varchar("wallet", { length: 64 }).primaryKey(),
    distinctMints: integer("distinct_mints").notNull().default(0),
    closedMints: integer("closed_mints").notNull().default(0),
    tradeCount: integer("trade_count").notNull().default(0),
    avgReturn: doublePrecision("avg_return"),
    stdReturn: doublePrecision("std_return"),
    tStat: doublePrecision("t_stat"),
    lastReturn: doublePrecision("last_return"),
    last5Return: doublePrecision("last5_return"),
    last10Return: doublePrecision("last10_return"),
    firstSeen: timestamp("first_seen", { withTimezone: true }),
    lastSeen: timestamp("last_seen", { withTimezone: true }),
    isBumpBot: boolean("is_bump_bot").notNull().default(false),
    bumpScore: doublePrecision("bump_score"),
    sniperRate: doublePrecision("sniper_rate"),
    bundleRate: doublePrecision("bundle_rate"),
    /** rolling window of last 15 coin realized returns, oldest→newest */
    recentReturns: jsonb("recent_returns"),
    lastUpdated: timestamp("last_updated", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tstat: index("wallet_profiles_tstat_idx").on(t.tStat),
    last: index("wallet_profiles_last_seen_idx").on(t.lastSeen),
    bump: index("wallet_profiles_bump_idx").on(t.isBumpBot),
  }),
);

export type MintBotFlagsRow = typeof mintBotFlags.$inferSelect;
export type WalletProfileRow = typeof walletProfiles.$inferSelect;
