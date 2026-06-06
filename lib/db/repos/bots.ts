import "server-only";
import { sql, desc, eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { mintBotFlags, walletProfiles } from "@/lib/db/schema";

export type MintFlags = {
  mint: string;
  hasBundle: boolean;
  hasSniper: boolean;
  hasBumpBot: boolean;
  mechanicalUptrend: boolean;
  bundleWalletCount: number;
  sniperWalletCount: number;
  bumpWalletCount: number;
  earlyUniqueBuyers: number;
  creator: string | null;
};

export async function upsertMintFlags(opts: {
  mint: string;
  creator: string | null;
  launchSlot: bigint | null;
  launchTs: Date | null;
  hasBundle: boolean;
  hasSniper: boolean;
  hasBumpBot: boolean;
  mechanicalUptrend: boolean;
  bundleWalletCount: number;
  sniperWalletCount: number;
  bumpWalletCount: number;
  earlyUniqueBuyers: number;
  raw?: Record<string, unknown> | null;
}): Promise<void> {
  await getDb()
    .insert(mintBotFlags)
    .values({
      mint: opts.mint,
      creator: opts.creator,
      launchSlot: opts.launchSlot,
      launchTs: opts.launchTs,
      hasBundle: opts.hasBundle,
      hasSniper: opts.hasSniper,
      hasBumpBot: opts.hasBumpBot,
      mechanicalUptrend: opts.mechanicalUptrend,
      bundleWalletCount: opts.bundleWalletCount,
      sniperWalletCount: opts.sniperWalletCount,
      bumpWalletCount: opts.bumpWalletCount,
      earlyUniqueBuyers: opts.earlyUniqueBuyers,
      raw: opts.raw ?? null,
      detectedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: mintBotFlags.mint,
      set: {
        hasBundle: opts.hasBundle,
        hasSniper: opts.hasSniper,
        hasBumpBot: opts.hasBumpBot,
        mechanicalUptrend: opts.mechanicalUptrend,
        bundleWalletCount: opts.bundleWalletCount,
        sniperWalletCount: opts.sniperWalletCount,
        bumpWalletCount: opts.bumpWalletCount,
        earlyUniqueBuyers: opts.earlyUniqueBuyers,
        raw: opts.raw ?? null,
        detectedAt: new Date(),
      },
    });
}

export async function fetchMintFlags(mint: string): Promise<MintFlags | null> {
  const rows = await getDb()
    .select()
    .from(mintBotFlags)
    .where(eq(mintBotFlags.mint, mint))
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  return {
    mint: r.mint,
    hasBundle: r.hasBundle,
    hasSniper: r.hasSniper,
    hasBumpBot: r.hasBumpBot,
    mechanicalUptrend: r.mechanicalUptrend,
    bundleWalletCount: r.bundleWalletCount,
    sniperWalletCount: r.sniperWalletCount,
    bumpWalletCount: r.bumpWalletCount,
    earlyUniqueBuyers: r.earlyUniqueBuyers,
    creator: r.creator ?? null,
  };
}

export async function fetchManyMintFlags(mints: string[]): Promise<Map<string, MintFlags>> {
  if (mints.length === 0) return new Map();
  const res = await getDb().execute(sql`
    SELECT mint, creator, has_bundle, has_sniper, has_bump_bot, mechanical_uptrend,
      bundle_wallet_count, sniper_wallet_count, bump_wallet_count, early_unique_buyers
    FROM mint_bot_flags
    WHERE mint = ANY(${sql.raw(`ARRAY[${mints.map((m) => `'${m.replace(/'/g, "''")}'`).join(",")}]::varchar[]`)})
  `);
  type Raw = {
    mint: string; creator: string | null;
    has_bundle: boolean; has_sniper: boolean; has_bump_bot: boolean;
    mechanical_uptrend: boolean;
    bundle_wallet_count: number; sniper_wallet_count: number;
    bump_wallet_count: number; early_unique_buyers: number;
  };
  const out = new Map<string, MintFlags>();
  for (const r of (res as unknown as { rows: Raw[] }).rows) {
    out.set(r.mint, {
      mint: r.mint,
      creator: r.creator,
      hasBundle: r.has_bundle,
      hasSniper: r.has_sniper,
      hasBumpBot: r.has_bump_bot,
      mechanicalUptrend: r.mechanical_uptrend,
      bundleWalletCount: r.bundle_wallet_count,
      sniperWalletCount: r.sniper_wallet_count,
      bumpWalletCount: r.bump_wallet_count,
      earlyUniqueBuyers: r.early_unique_buyers,
    });
  }
  return out;
}

export type SmartMoneyRow = {
  wallet: string;
  tradeCount: number;
  distinctMints: number;
  closedMints: number;
  avgReturn: number | null;
  stdReturn: number | null;
  tStat: number | null;
  lastReturn: number | null;
  last5Return: number | null;
  last10Return: number | null;
  isBumpBot: boolean;
  sniperRate: number | null;
  bundleRate: number | null;
  lastSeen: string | null;
  clusterId: string | null;
  clusterKind: string | null;
  clusterMembers: number | null;
  clusterConfidence: number | null;
};

export type SmartMoneyOpts = {
  limit?: number;
  minTstat?: number;
  minClosed?: number;
  /** When true, drop wallets that belong to a known bundle/sniper ring. */
  excludeRingMembers?: boolean;
};

export async function fetchSmartMoney(opts: SmartMoneyOpts = {}): Promise<SmartMoneyRow[]> {
  const limit = opts.limit ?? 50;
  const minT = opts.minTstat ?? 1.0;
  const minC = opts.minClosed ?? 5;
  const excludeRings = opts.excludeRingMembers ?? false;
  // Pull a wider candidate pool then trim after the LEFT JOIN so we always
  // return exactly `limit` rows even when several get filtered out.
  const fetchLimit = excludeRings ? limit * 4 : limit;
  const res = await getDb().execute(sql`
    SELECT wp.wallet,
      wp.trade_count, wp.distinct_mints, wp.closed_mints,
      wp.avg_return, wp.std_return, wp.t_stat,
      wp.last_return, wp.last5_return, wp.last10_return,
      wp.is_bump_bot, wp.sniper_rate, wp.bundle_rate,
      to_char(wp.last_seen, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS last_seen,
      cm.cluster_id::text AS cluster_id,
      c.kind::text         AS cluster_kind,
      c.member_count::int  AS cluster_members,
      c.confidence::float8 AS cluster_confidence
    FROM wallet_profiles wp
    LEFT JOIN cluster_members cm ON cm.wallet = wp.wallet
    LEFT JOIN clusters c         ON c.id = cm.cluster_id
    WHERE COALESCE(wp.t_stat, 0) >= ${minT}
      AND COALESCE(wp.closed_mints, 0) >= ${minC}
      AND wp.is_bump_bot = false
      ${excludeRings ? sql`AND (cm.cluster_id IS NULL OR c.kind NOT IN ('bundle_ring','sniper_ring'))` : sql``}
    ORDER BY wp.t_stat DESC NULLS LAST
    LIMIT ${sql.raw(String(fetchLimit))}
  `);
  type Raw = {
    wallet: string;
    trade_count: number; distinct_mints: number; closed_mints: number;
    avg_return: number | null; std_return: number | null; t_stat: number | null;
    last_return: number | null; last5_return: number | null; last10_return: number | null;
    is_bump_bot: boolean; sniper_rate: number | null; bundle_rate: number | null;
    last_seen: string | null;
    cluster_id: string | null;
    cluster_kind: string | null;
    cluster_members: number | null;
    cluster_confidence: number | null;
  };
  // The LEFT JOIN can multiply rows when a wallet is in >1 cluster.
  // Dedupe by wallet, preferring bundle_ring > sniper_ring > co_buy.
  const byWallet = new Map<string, Raw>();
  const priority = (k: string | null) =>
    k === "bundle_ring" ? 3 : k === "sniper_ring" ? 2 : k === "co_buy" ? 1 : 0;
  for (const row of (res as unknown as { rows: Raw[] }).rows) {
    const existing = byWallet.get(row.wallet);
    if (!existing || priority(row.cluster_kind) > priority(existing.cluster_kind)) {
      byWallet.set(row.wallet, row);
    }
  }
  return Array.from(byWallet.values())
    .slice(0, limit)
    .map((r) => ({
      wallet: r.wallet,
      tradeCount: r.trade_count,
      distinctMints: r.distinct_mints,
      closedMints: r.closed_mints,
      avgReturn: r.avg_return,
      stdReturn: r.std_return,
      tStat: r.t_stat,
      lastReturn: r.last_return,
      last5Return: r.last5_return,
      last10Return: r.last10_return,
      isBumpBot: r.is_bump_bot,
      sniperRate: r.sniper_rate,
      bundleRate: r.bundle_rate,
      lastSeen: r.last_seen,
      clusterId: r.cluster_id,
      clusterKind: r.cluster_kind,
      clusterMembers: r.cluster_members,
      clusterConfidence: r.cluster_confidence,
    }));
}

/** Single wallet's full profile (no edge/sample filters) — for the copy-trade analyzer. */
export async function fetchWalletProfile(wallet: string): Promise<SmartMoneyRow | null> {
  const res = await getDb().execute(sql`
    SELECT wp.wallet,
      wp.trade_count, wp.distinct_mints, wp.closed_mints,
      wp.avg_return, wp.std_return, wp.t_stat,
      wp.last_return, wp.last5_return, wp.last10_return,
      wp.is_bump_bot, wp.sniper_rate, wp.bundle_rate,
      to_char(wp.last_seen, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS last_seen,
      cm.cluster_id::text AS cluster_id,
      c.kind::text         AS cluster_kind,
      c.member_count::int  AS cluster_members,
      c.confidence::float8 AS cluster_confidence
    FROM wallet_profiles wp
    LEFT JOIN cluster_members cm ON cm.wallet = wp.wallet
    LEFT JOIN clusters c         ON c.id = cm.cluster_id
    WHERE wp.wallet = ${wallet}
  `);
  type Raw = {
    wallet: string;
    trade_count: number; distinct_mints: number; closed_mints: number;
    avg_return: number | null; std_return: number | null; t_stat: number | null;
    last_return: number | null; last5_return: number | null; last10_return: number | null;
    is_bump_bot: boolean; sniper_rate: number | null; bundle_rate: number | null;
    last_seen: string | null;
    cluster_id: string | null; cluster_kind: string | null;
    cluster_members: number | null; cluster_confidence: number | null;
  };
  const rows = (res as unknown as { rows: Raw[] }).rows;
  if (rows.length === 0) return null;
  // A wallet may be in >1 cluster — keep the most severe (bundle > sniper > co-buy).
  const priority = (k: string | null) =>
    k === "bundle_ring" ? 3 : k === "sniper_ring" ? 2 : k === "co_buy" ? 1 : 0;
  const r = rows.reduce((a, b) => (priority(b.cluster_kind) > priority(a.cluster_kind) ? b : a));
  return {
    wallet: r.wallet,
    tradeCount: r.trade_count,
    distinctMints: r.distinct_mints,
    closedMints: r.closed_mints,
    avgReturn: r.avg_return,
    stdReturn: r.std_return,
    tStat: r.t_stat,
    lastReturn: r.last_return,
    last5Return: r.last5_return,
    last10Return: r.last10_return,
    isBumpBot: r.is_bump_bot,
    sniperRate: r.sniper_rate,
    bundleRate: r.bundle_rate,
    lastSeen: r.last_seen,
    clusterId: r.cluster_id,
    clusterKind: r.cluster_kind,
    clusterMembers: r.cluster_members,
    clusterConfidence: r.cluster_confidence,
  };
}

/**
 * Returns set of wallets that the recent buy flow on the given mint contains,
 * marked with their wallet-profile signals. Used by the wallet-gate to decide
 * whether the "buyers" of a hot mint look like smart money or bots.
 */
export async function fetchBuyerProfilesForMint(mint: string, limitMin = 5) {
  const res = await getDb().execute(sql`
    WITH recent_buyers AS (
      SELECT DISTINCT wallet
      FROM events
      WHERE mint = ${mint}
        AND kind = 'buy'
        -- Anchor the window to the latest event, NOT wall-clock now(): the host
        -- clock jumps forward after the machine sleeps, which would silently empty
        -- a now()-based window (all events look "old") and kill smart-money signals.
        AND ts >= (SELECT ts FROM events ORDER BY id DESC LIMIT 1) - interval '${sql.raw(String(limitMin))} minutes'
    )
    SELECT rb.wallet,
      wp.t_stat, wp.avg_return, wp.std_return, wp.trade_count,
      wp.is_bump_bot, wp.sniper_rate, wp.bundle_rate
    FROM recent_buyers rb
    LEFT JOIN wallet_profiles wp ON wp.wallet = rb.wallet
  `);
  type Raw = {
    wallet: string;
    t_stat: number | null;
    avg_return: number | null;
    std_return: number | null;
    trade_count: number | null;
    is_bump_bot: boolean | null;
    sniper_rate: number | null;
    bundle_rate: number | null;
  };
  return (res as unknown as { rows: Raw[] }).rows;
}

export async function upsertWalletProfile(opts: {
  wallet: string;
  tradeCount: number;
  distinctMints: number;
  closedMints: number;
  avgReturn: number | null;
  stdReturn: number | null;
  tStat: number | null;
  lastReturn: number | null;
  last5Return: number | null;
  last10Return: number | null;
  firstSeen: Date | null;
  lastSeen: Date | null;
  isBumpBot: boolean;
  bumpScore: number | null;
  sniperRate: number | null;
  bundleRate: number | null;
  recentReturns: number[];
}): Promise<void> {
  await getDb()
    .insert(walletProfiles)
    .values({
      wallet: opts.wallet,
      tradeCount: opts.tradeCount,
      distinctMints: opts.distinctMints,
      closedMints: opts.closedMints,
      avgReturn: opts.avgReturn,
      stdReturn: opts.stdReturn,
      tStat: opts.tStat,
      lastReturn: opts.lastReturn,
      last5Return: opts.last5Return,
      last10Return: opts.last10Return,
      firstSeen: opts.firstSeen,
      lastSeen: opts.lastSeen,
      isBumpBot: opts.isBumpBot,
      bumpScore: opts.bumpScore,
      sniperRate: opts.sniperRate,
      bundleRate: opts.bundleRate,
      recentReturns: opts.recentReturns,
      lastUpdated: new Date(),
    })
    .onConflictDoUpdate({
      target: walletProfiles.wallet,
      set: {
        tradeCount: opts.tradeCount,
        distinctMints: opts.distinctMints,
        closedMints: opts.closedMints,
        avgReturn: opts.avgReturn,
        stdReturn: opts.stdReturn,
        tStat: opts.tStat,
        lastReturn: opts.lastReturn,
        last5Return: opts.last5Return,
        last10Return: opts.last10Return,
        lastSeen: opts.lastSeen,
        isBumpBot: opts.isBumpBot,
        bumpScore: opts.bumpScore,
        sniperRate: opts.sniperRate,
        bundleRate: opts.bundleRate,
        recentReturns: opts.recentReturns,
        lastUpdated: new Date(),
      },
    });
}

export async function fetchSmartMoneyTstatPctile(p: number): Promise<number> {
  // p in [0,1]
  const res = await getDb().execute(sql`
    SELECT percentile_cont(${p}) WITHIN GROUP (ORDER BY t_stat) AS v
    FROM wallet_profiles
    WHERE t_stat IS NOT NULL AND closed_mints >= 5 AND is_bump_bot = false
  `);
  const v = (res as unknown as { rows: Array<{ v: number | null }> }).rows[0]?.v;
  return v ?? 0;
}

export type SmartMoneyBuyer = {
  wallet: string;
  tStat: number | null;
  avgReturn: number | null;
  closedMints: number;
  solAmount: number | null;
};

/** Wallets with proven edge currently buying this mint (last 5 min). */
export async function fetchSmartMoneyBuyersForMint(
  mint: string,
  minTStat = 1.645,
): Promise<SmartMoneyBuyer[]> {
  const res = await getDb().execute(sql`
    WITH recent AS (
      SELECT wallet, MAX(sol_amount)::float8 AS sol_amount
      FROM events
      WHERE mint = ${mint}
        AND kind = 'buy'
        AND wallet IS NOT NULL
        -- data-clock anchor (clock-jump robust); see fetchBuyerProfilesForMint.
        AND ts >= (SELECT ts FROM events ORDER BY id DESC LIMIT 1) - interval '5 minutes'
      GROUP BY wallet
    )
    SELECT rb.wallet,
      wp.t_stat::float8 AS t_stat,
      wp.avg_return::float8 AS avg_return,
      COALESCE(wp.closed_mints, 0)::int AS closed_mints,
      rb.sol_amount
    FROM recent rb
    JOIN wallet_profiles wp ON wp.wallet = rb.wallet
    WHERE COALESCE(wp.t_stat, 0) >= ${minTStat}
      AND COALESCE(wp.avg_return, 0) > 0
      AND wp.is_bump_bot = false
      AND COALESCE(wp.closed_mints, 0) >= 3
    ORDER BY wp.t_stat DESC NULLS LAST
    LIMIT 8
  `);
  type Raw = {
    wallet: string;
    t_stat: number | null;
    avg_return: number | null;
    closed_mints: number;
    sol_amount: number | null;
  };
  return (res as unknown as { rows: Raw[] }).rows.map((r) => ({
    wallet: r.wallet,
    tStat: r.t_stat,
    avgReturn: r.avg_return,
    closedMints: r.closed_mints,
    solAmount: r.sol_amount,
  }));
}

/** Batch smart-money buyer counts for many mints (recent 5 min). */
export async function fetchManySmartMoneyCounts(
  mints: string[],
  minTStat = 1.645,
): Promise<Map<string, number>> {
  if (mints.length === 0) return new Map();
  const arr = mints.map((m) => `'${m.replace(/'/g, "''")}'`).join(",");
  const res = await getDb().execute(sql`
    WITH recent AS (
      SELECT mint, wallet
      FROM events
      WHERE mint = ANY(${sql.raw(`ARRAY[${arr}]::varchar[]`)})
        AND kind = 'buy'
        AND wallet IS NOT NULL
        -- data-clock anchor (clock-jump robust); see fetchBuyerProfilesForMint.
        AND ts >= (SELECT ts FROM events ORDER BY id DESC LIMIT 1) - interval '5 minutes'
      GROUP BY mint, wallet
    )
    SELECT rb.mint, COUNT(*)::int AS n
    FROM recent rb
    JOIN wallet_profiles wp ON wp.wallet = rb.wallet
    WHERE COALESCE(wp.t_stat, 0) >= ${minTStat}
      AND COALESCE(wp.avg_return, 0) > 0
      AND wp.is_bump_bot = false
      AND COALESCE(wp.closed_mints, 0) >= 3
    GROUP BY rb.mint
  `);
  const out = new Map<string, number>();
  for (const r of (res as unknown as { rows: Array<{ mint: string; n: number }> }).rows) {
    out.set(r.mint, r.n);
  }
  return out;
}
