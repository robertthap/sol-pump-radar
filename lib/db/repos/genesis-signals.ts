import "server-only";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import type { GenesisSignal } from "@/lib/intelligence/genesis-snipe";

/**
 * Fresh-mint genesis-snipe candidates — built 2026-06-15.
 *
 * Strategy: find mints with a `create` event recent enough to potentially be in
 * the genesis window (age <= maxAgeSec), then aggregate their last-30s
 * bonding-curve activity. Returns the inputs to evaluateGenesisSnipe.
 *
 * Clock-jump safety: we anchor the windows to the data clock (latest event ts),
 * not now() — this is the same pattern used elsewhere in the codebase to
 * survive host clock jumps (Windows sleep, etc.).
 */
export async function fetchGenesisSnipeCandidates(opts?: {
  maxAgeSec?: number;
  limit?: number;
}): Promise<GenesisSignal[]> {
  const maxAgeSec = opts?.maxAgeSec ?? 60;
  const limit = opts?.limit ?? 30;
  const res = await getDb().execute(sql`
    WITH data_now AS (
      SELECT COALESCE(
        (SELECT ts FROM events ORDER BY id DESC LIMIT 1),
        now()
      ) AS now_ts
    ),
    fresh AS (
      SELECT
        c.mint::text AS mint,
        c.ts AS create_ts,
        (SELECT now_ts FROM data_now) AS data_now_ts
      FROM events c
      CROSS JOIN data_now d
      WHERE c.kind = 'create'
        AND c.ts > d.now_ts - (${sql.raw(String(maxAgeSec))} || ' seconds')::interval
      ORDER BY c.ts DESC
      LIMIT ${limit}
    )
    SELECT
      f.mint,
      EXTRACT(EPOCH FROM (f.data_now_ts - f.create_ts))::float8 AS age_sec,
      -- current curve vSol = most recent v_sol_after across all event kinds
      (SELECT v_sol_after::float8 FROM events e
        WHERE e.mint = f.mint AND e.v_sol_after IS NOT NULL
        ORDER BY ts DESC LIMIT 1) AS current_v_sol,
      -- initial (earliest) curve vSol for growth signal
      (SELECT v_sol_after::float8 FROM events e
        WHERE e.mint = f.mint AND e.v_sol_after IS NOT NULL
        ORDER BY ts ASC LIMIT 1) AS initial_v_sol,
      -- last-30s window — anchored to data clock
      (SELECT COUNT(*)::int FROM events e
        WHERE e.mint = f.mint AND e.kind = 'buy'
          AND e.ts > f.data_now_ts - interval '30 seconds') AS buys_30s,
      (SELECT COUNT(*)::int FROM events e
        WHERE e.mint = f.mint AND e.kind = 'sell'
          AND e.ts > f.data_now_ts - interval '30 seconds') AS sells_30s,
      (SELECT COUNT(DISTINCT wallet)::int FROM events e
        WHERE e.mint = f.mint AND e.kind = 'buy' AND e.wallet IS NOT NULL
          AND e.ts > f.data_now_ts - interval '30 seconds') AS unique_buyers_30s,
      (SELECT COALESCE(SUM(sol_amount::float8), 0)::float8 FROM events e
        WHERE e.mint = f.mint AND e.kind = 'buy'
          AND e.ts > f.data_now_ts - interval '30 seconds') AS buy_vol_sol_30s,
      (SELECT COALESCE(SUM(sol_amount::float8), 0)::float8 FROM events e
        WHERE e.mint = f.mint AND e.kind = 'sell'
          AND e.ts > f.data_now_ts - interval '30 seconds') AS sell_vol_sol_30s
    FROM fresh f
  `);
  type Row = {
    mint: string;
    age_sec: number;
    current_v_sol: number | null;
    initial_v_sol: number | null;
    buys_30s: number;
    sells_30s: number;
    unique_buyers_30s: number;
    buy_vol_sol_30s: number;
    sell_vol_sol_30s: number;
  };
  const rows = (res as unknown as { rows: Row[] }).rows;
  return rows
    .filter((r) => r.current_v_sol != null && Number.isFinite(r.current_v_sol))
    .map((r) => ({
      mint: r.mint,
      ageSec: r.age_sec,
      currentVSol: r.current_v_sol as number,
      initialVSol: r.initial_v_sol,
      buys30s: r.buys_30s,
      sells30s: r.sells_30s,
      uniqueBuyers30s: r.unique_buyers_30s,
      buyVolSol30s: r.buy_vol_sol_30s,
      sellVolSol30s: r.sell_vol_sol_30s,
    }));
}
