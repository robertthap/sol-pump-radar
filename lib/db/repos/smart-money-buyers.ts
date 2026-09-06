import "server-only";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import type { SmartMoneyCandidate } from "@/lib/trade/smart-money";

/**
 * Recent buyers of a mint, split into the operator's watched wallets and the
 * ones our own statistics rate as having an edge.
 *
 * One query, not three. This runs on the entry path for every candidate, so a
 * watchlist read + a profile read + a cluster read per mint would be three
 * round trips where one does. The `avoid` filtering itself is pure and lives in
 * lib/trade/smart-money.ts; this only supplies the facts.
 *
 * Both sides come from the same `events` scan, which means both inherit the
 * same limitation: `events` holds bonding-curve trades only (PUMPSWAP_INGEST is
 * off), so a wallet buying a graduated coin on PumpSwap is invisible here. That
 * is a source of FALSE NEGATIVES - no signal where there should be one - never
 * a false positive, which is the safe direction for a gate to fail in.
 */

export type SmartMoneyBuyers = {
  watchlistBuyers: SmartMoneyCandidate[];
  profiledBuyers: SmartMoneyCandidate[];
};

const MIN_T_STAT = 1.645;
const MIN_CLOSED_MINTS = 3;

export async function fetchSmartMoneyBuyers(mint: string, windowMin = 5): Promise<SmartMoneyBuyers> {
  const res = await getDb().execute(sql`
    WITH recent AS (
      SELECT wallet, MAX(sol_amount)::float8 AS sol_amount
      FROM events
      WHERE mint = ${mint}
        AND kind = 'buy'
        AND wallet IS NOT NULL
        -- Anchored to the newest event, not now(): the host clock jumps forward
        -- after the machine sleeps, which would silently empty a now()-based
        -- window and kill the signal. Same anchor as fetchBuyerProfilesForMint.
        AND ts >= (SELECT ts FROM events ORDER BY id DESC LIMIT 1)
                  - interval '${sql.raw(String(Math.max(1, Math.floor(windowMin))))} minutes'
      GROUP BY wallet
    )
    SELECT r.wallet, r.sol_amount,
      (ww.wallet IS NOT NULL) AS watched,
      wp.trade_count, wp.distinct_mints, wp.closed_mints,
      wp.avg_return, wp.t_stat, wp.last5_return, wp.last10_return,
      wp.is_bump_bot, wp.sniper_rate, wp.bundle_rate,
      to_char(wp.last_seen, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS last_seen,
      c.kind::text        AS cluster_kind,
      c.member_count::int AS cluster_members
    FROM recent r
    LEFT JOIN wallet_watchlist ww ON ww.wallet = r.wallet AND ww.active
    LEFT JOIN wallet_profiles  wp ON wp.wallet = r.wallet
    LEFT JOIN cluster_members  cm ON cm.wallet = r.wallet
    LEFT JOIN clusters         c  ON c.id = cm.cluster_id
    WHERE ww.wallet IS NOT NULL
       OR (COALESCE(wp.t_stat, 0) >= ${MIN_T_STAT}
           AND COALESCE(wp.avg_return, 0) > 0
           AND wp.is_bump_bot = false
           AND COALESCE(wp.closed_mints, 0) >= ${MIN_CLOSED_MINTS})
  `);

  type Raw = {
    wallet: string;
    sol_amount: number | null;
    watched: boolean;
    trade_count: number | null;
    distinct_mints: number | null;
    closed_mints: number | null;
    avg_return: number | null;
    t_stat: number | null;
    last5_return: number | null;
    last10_return: number | null;
    is_bump_bot: boolean | null;
    sniper_rate: number | null;
    bundle_rate: number | null;
    last_seen: string | null;
    cluster_kind: string | null;
    cluster_members: number | null;
  };

  // The cluster LEFT JOIN multiplies rows for a wallet in more than one cluster.
  // Keep the most damning kind, matching fetchSmartMoney's precedence.
  const priority = (k: string | null) => (k === "bundle_ring" ? 3 : k === "sniper_ring" ? 2 : k === "co_buy" ? 1 : 0);
  const byWallet = new Map<string, Raw>();
  for (const row of (res as unknown as { rows: Raw[] }).rows) {
    const prev = byWallet.get(row.wallet);
    if (!prev || priority(row.cluster_kind) > priority(prev.cluster_kind)) byWallet.set(row.wallet, row);
  }

  const watchlistBuyers: SmartMoneyCandidate[] = [];
  const profiledBuyers: SmartMoneyCandidate[] = [];
  for (const r of byWallet.values()) {
    const candidate: SmartMoneyCandidate = {
      wallet: r.wallet,
      solAmount: r.sol_amount,
      // Null when we hold no profile at all - common for watched wallets, and
      // not disqualifying. analyzeCopyTradeSafety returns "unknown" for it.
      profile:
        r.trade_count == null
          ? null
          : {
              wallet: r.wallet,
              tradeCount: r.trade_count ?? 0,
              distinctMints: r.distinct_mints ?? 0,
              closedMints: r.closed_mints ?? 0,
              avgReturn: r.avg_return,
              tStat: r.t_stat,
              last5Return: r.last5_return,
              last10Return: r.last10_return,
              isBumpBot: r.is_bump_bot === true,
              sniperRate: r.sniper_rate,
              bundleRate: r.bundle_rate,
              clusterKind: r.cluster_kind,
              clusterMembers: r.cluster_members,
              lastSeen: r.last_seen,
            },
    };
    // A watched wallet counts as the operator's, never as ours, even when it
    // also clears our bar - otherwise it would be counted twice toward a tier.
    if (r.watched) watchlistBuyers.push(candidate);
    else profiledBuyers.push(candidate);
  }

  return { watchlistBuyers, profiledBuyers };
}
