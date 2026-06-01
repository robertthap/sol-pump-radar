import "server-only";

import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";

export type SellablePaperRow = {
  id: string;
  mint: string;
  entry_v_sol: number | null;
  opened_at: Date;
  modules_at_entry: Record<string, number> | null;
  entry_features: Record<string, unknown> | null;
};

/** Open demo + auto-trader paper positions eligible for manual sell. */
export async function fetchSellableOpenPaperPositions(opts?: {
  sessionId?: string | null;
}): Promise<SellablePaperRow[]> {
  const sessionId = opts?.sessionId?.trim() || null;
  const res = await getDb().execute(sql`
    SELECT
      id::text AS id,
      mint::text AS mint,
      entry_price::float8 AS entry_v_sol,
      opened_at,
      modules_at_entry,
      entry_features
    FROM paper_positions
    WHERE state = 'OPEN'
      AND (
        entry_features->>'ui_mode' = 'demo'
        OR (
          COALESCE(entry_features->>'auto', 'false') = 'true'
          AND COALESCE(entry_features->>'session_mode', '') = 'paper'
          AND entry_features->>'shadow_of' IS NULL
          AND COALESCE(entry_features->>'purpose', '') <> 'shadow_learn'
        )
      )
      AND (
        ${sessionId}::text IS NULL
        OR entry_features->>'session_id' = ${sessionId}
      )
    ORDER BY opened_at ASC
  `);
  return (res as unknown as { rows: SellablePaperRow[] }).rows;
}
