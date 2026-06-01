import "server-only";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { PAPER_TRADES_READ } from "@/lib/db/paper-read";

export type GateOutcomeRow = {
  walletConf: number;
  coinConf: number;
  timingConf: number;
  pnlSol: number;
};

/**
 * Returns auto-trade outcomes that include three-gate confidences in
 * entry_features. We need at least one of the per-gate confidences saved.
 *
 * windowHours: lookback window. Includes paper + live closed trades.
 */
export async function fetchGateOutcomes(
  windowHours = 24 * 7,
  limit = 500,
): Promise<GateOutcomeRow[]> {
  const interval = `${windowHours} hours`;
  const res = await getDb().execute(sql`
    SELECT * FROM (
      SELECT
        (entry_features ->> 'gateWalletConf')::float8 AS wallet_conf,
        (entry_features ->> 'gateCoinConf')::float8   AS coin_conf,
        (entry_features ->> 'gateTimingConf')::float8 AS timing_conf,
        pnl_sol::float8                                AS pnl_sol
      FROM ${sql.raw(PAPER_TRADES_READ)}
      WHERE status = 'closed'
        AND closed_at > now() - ${sql.raw(`'${interval}'::interval`)}
        AND entry_features ? 'gateWalletConf'
      UNION ALL
      SELECT
        (entry_features ->> 'gateWalletConf')::float8 AS wallet_conf,
        (entry_features ->> 'gateCoinConf')::float8   AS coin_conf,
        (entry_features ->> 'gateTimingConf')::float8 AS timing_conf,
        pnl_sol::float8                                AS pnl_sol
      FROM live_trades
      WHERE status = 'closed'
        AND closed_at > now() - ${sql.raw(`'${interval}'::interval`)}
        AND entry_features ? 'gateWalletConf'
    ) g
    WHERE pnl_sol IS NOT NULL
    ORDER BY pnl_sol DESC
    LIMIT ${sql.raw(String(limit))}
  `);
  type Raw = {
    wallet_conf: number | null;
    coin_conf: number | null;
    timing_conf: number | null;
    pnl_sol: number | null;
  };
  const rows = (res as unknown as { rows: Raw[] }).rows;
  return rows
    .filter((r) => r.pnl_sol != null)
    .map((r) => ({
      walletConf: r.wallet_conf ?? 0,
      coinConf: r.coin_conf ?? 0,
      timingConf: r.timing_conf ?? 0,
      pnlSol: r.pnl_sol!,
    }));
}
