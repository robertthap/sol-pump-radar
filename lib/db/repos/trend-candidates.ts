import "server-only";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";

export type TrendCandidateRow = {
  mint: string;
  vSol: number | null;
  prevVSol: number | null;
  lastTradeAt: Date | string | null;
  source: string;
  updatedAt: Date | string;
};

export async function upsertTrendCandidates(
  rows: Array<{
    mint: string;
    vSol: number | null;
    lastTradeAt: Date | string | null;
    source: string;
  }>,
): Promise<void> {
  if (!rows.length) return;
  for (const r of rows) {
    await getDb().execute(sql`
      INSERT INTO trend_candidates (mint, v_sol, prev_v_sol, last_trade_at, source, updated_at)
      VALUES (
        ${r.mint},
        ${r.vSol},
        NULL,
        ${r.lastTradeAt instanceof Date ? r.lastTradeAt.toISOString() : r.lastTradeAt},
        ${r.source},
        now()
      )
      ON CONFLICT (mint) DO UPDATE SET
        prev_v_sol = trend_candidates.v_sol,
        v_sol = EXCLUDED.v_sol,
        last_trade_at = COALESCE(EXCLUDED.last_trade_at, trend_candidates.last_trade_at),
        source = EXCLUDED.source,
        updated_at = now()
    `);
  }
}

export async function fetchRecentTrendMints(maxAgeMinutes = 30): Promise<string[]> {
  const res = await getDb().execute(sql`
    SELECT mint::text AS mint
    FROM trend_candidates
    WHERE updated_at > now() - (${sql.raw(String(maxAgeMinutes))} || ' minutes')::interval
  `);
  return (res as unknown as { rows: Array<{ mint: string }> }).rows.map((r) => r.mint);
}
