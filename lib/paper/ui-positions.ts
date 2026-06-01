import "server-only";

import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";

export type UiPaperPositionRow = {
  id: string;
  mint: string;
  symbol: string | null;
  size_sol: number;
  entry_v_sol: number | null;
  exit_v_sol: number | null;
  realized_pnl_sol: number | null;
  state: string;
  entry_features: Record<string, unknown> | null;
};

/** Demo + auto-trader paper rows shown on /paper and /api/positions. */
export async function fetchUiPaperPositions(limit = 25): Promise<UiPaperPositionRow[]> {
  const cap = Math.min(100, Math.max(1, limit));
  const res = await getDb().execute(sql`
    SELECT
      id::text AS id,
      mint::text AS mint,
      symbol::text AS symbol,
      notional_sol::float8 AS size_sol,
      entry_price::float8 AS entry_v_sol,
      exit_price::float8 AS exit_v_sol,
      realized_pnl_sol::float8 AS realized_pnl_sol,
      state::text AS state,
      entry_features
    FROM paper_positions
    WHERE entry_features->>'ui_mode' = 'demo'
       OR (
         COALESCE(entry_features->>'auto', 'false') = 'true'
         AND COALESCE(entry_features->>'session_mode', '') = 'paper'
         AND entry_features->>'shadow_of' IS NULL
         AND COALESCE(entry_features->>'purpose', '') <> 'shadow_learn'
       )
    ORDER BY opened_at DESC
    LIMIT ${cap}
  `);
  return (res as unknown as { rows: UiPaperPositionRow[] }).rows;
}
