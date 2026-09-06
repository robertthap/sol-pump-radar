import "server-only";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { executeWebMutation, WebWriteOp } from "@/lib/runtime/web-writes";

export type WatchedWallet = {
  wallet: string;
  label: string | null;
  note: string | null;
  active: boolean;
  addedAt: string;
  /**
   * What OUR data says about this wallet, or null if we have never profiled it.
   *
   * Shown next to the operator's own judgement rather than gating on it. Our
   * scoring cannot currently validate these wallets: every ingested event is
   * venue='curve' (PUMPSWAP_INGEST defaults off), so a wallet that takes profit
   * after graduation is booked as a total loss. A negative number here is
   * evidence about our coverage at least as much as about the wallet.
   */
  profile: {
    avgReturn: number | null;
    tStat: number | null;
    closedMints: number;
    distinctMints: number;
    bundleRate: number | null;
    /** Passes the same bar fetchSmartMoneyBuyersForMint applies. */
    qualifies: boolean;
  } | null;
};

/**
 * The operator's "smart money" list. Reads are cheap and uncached on purpose:
 * the entry path holds its own short-lived cache (see lib/trade/smart-money),
 * and the settings UI must always show what was actually stored.
 */
export async function listWatchedWallets(opts?: { includeInactive?: boolean }): Promise<WatchedWallet[]> {
  // One LEFT JOIN rather than a profile lookup per row: the list is small but
  // this is rendered on every settings load, and N+1 here would be gratuitous.
  const res = await getDb().execute(sql`
    SELECT w.wallet, w.label, w.note, w.active, w.added_at::text AS added_at,
           p.avg_return::float8      AS avg_return,
           p.t_stat::float8          AS t_stat,
           COALESCE(p.closed_mints, 0)::int   AS closed_mints,
           COALESCE(p.distinct_mints, 0)::int AS distinct_mints,
           p.bundle_rate::float8     AS bundle_rate,
           (p.wallet IS NOT NULL)    AS profiled,
           (COALESCE(p.t_stat, 0) >= 1.645
            AND COALESCE(p.avg_return, 0) > 0
            AND p.is_bump_bot = false
            AND COALESCE(p.closed_mints, 0) >= 3) AS qualifies
    FROM wallet_watchlist w
    LEFT JOIN wallet_profiles p ON p.wallet = w.wallet
    ${opts?.includeInactive ? sql`` : sql`WHERE w.active`}
    ORDER BY w.added_at DESC, w.wallet ASC
  `);
  return (res as unknown as { rows: Array<Record<string, unknown>> }).rows.map((r) => ({
    wallet: String(r.wallet),
    label: r.label == null ? null : String(r.label),
    note: r.note == null ? null : String(r.note),
    active: r.active === true,
    addedAt: String(r.added_at),
    profile:
      r.profiled === true
        ? {
            avgReturn: r.avg_return == null ? null : Number(r.avg_return),
            tStat: r.t_stat == null ? null : Number(r.t_stat),
            closedMints: Number(r.closed_mints),
            distinctMints: Number(r.distinct_mints),
            bundleRate: r.bundle_rate == null ? null : Number(r.bundle_rate),
            qualifies: r.qualifies === true,
          }
        : null,
  }));
}

/** Just the addresses currently being followed - the entry path's hot read. */
export async function listActiveWatchedAddresses(): Promise<string[]> {
  const res = await getDb().execute(sql`SELECT wallet FROM wallet_watchlist WHERE active`);
  return (res as unknown as { rows: Array<{ wallet: string }> }).rows.map((r) => String(r.wallet));
}

/**
 * Add addresses in bulk. Callers pass only addresses that already survived
 * parseWatchlistInput, so validation is NOT repeated here - the caller owns the
 * per-address rejection reasons and this owns persistence.
 *
 * Re-adding a wallet that was previously removed reactivates it rather than
 * failing: removal is a soft delete, so "add it back" must be able to undo it.
 */
export async function addWatchedWallets(
  addresses: string[],
  label?: string | null,
): Promise<{ added: number; reactivated: number }> {
  if (addresses.length === 0) return { added: 0, reactivated: 0 };
  return executeWebMutation(WebWriteOp.SETTINGS_WATCHLIST, async (client) => {
    const before = await client.query<{ wallet: string; active: boolean }>(
      `SELECT wallet, active FROM wallet_watchlist WHERE wallet = ANY($1::text[])`,
      [addresses],
    );
    const known = new Map(before.rows.map((r) => [r.wallet, r.active]));
    await client.query(
      `INSERT INTO wallet_watchlist (wallet, label)
       SELECT unnest($1::text[]), $2
       ON CONFLICT (wallet) DO UPDATE
         SET active = true,
             label = COALESCE(EXCLUDED.label, wallet_watchlist.label)`,
      [addresses, label ?? null],
    );
    let added = 0;
    let reactivated = 0;
    for (const a of addresses) {
      if (!known.has(a)) added++;
      else if (known.get(a) === false) reactivated++;
    }
    return { added, reactivated };
  });
}

/** Soft delete - the record of what was tried is worth more than the row is costly. */
export async function removeWatchedWallet(wallet: string): Promise<boolean> {
  return executeWebMutation(WebWriteOp.SETTINGS_WATCHLIST, async (client) => {
    const r = await client.query(`UPDATE wallet_watchlist SET active = false WHERE wallet = $1 AND active`, [wallet]);
    return (r.rowCount ?? 0) > 0;
  });
}
