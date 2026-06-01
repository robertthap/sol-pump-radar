import "server-only";

import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";

export type ClosedPaperPositionRow = {
  id: string;
  session_id: string;
  mint: string;
  symbol: string | null;
  side: string;
  state: string;
  entry_price: number;
  exit_price: number | null;
  quantity: number;
  notional_sol: number;
  realized_pnl_sol: number | null;
  close_reason: string | null;
  opened_at: Date | string;
  closed_at: Date | string | null;
};

export async function fetchClosedPaperHistory(opts?: {
  limit?: number;
  sessionId?: string | null;
}): Promise<ClosedPaperPositionRow[]> {
  const limit = Math.min(200, Math.max(1, opts?.limit ?? 50));
  const sessionId = opts?.sessionId?.trim() || null;
  const res = await getDb().execute(sql`
    SELECT id::text AS id,
           session_id::text AS session_id,
           mint,
           symbol,
           side,
           state,
           entry_price::float8 AS entry_price,
           exit_price::float8 AS exit_price,
           quantity::float8 AS quantity,
           notional_sol::float8 AS notional_sol,
           realized_pnl_sol::float8 AS realized_pnl_sol,
           close_reason,
           opened_at,
           closed_at
    FROM paper_positions
    WHERE state = 'CLOSED'
      ${sessionId ? sql`AND session_id = ${sessionId}::bigint` : sql``}
    ORDER BY closed_at DESC NULLS LAST, id DESC
    LIMIT ${limit}
  `);
  return (res as unknown as { rows: ClosedPaperPositionRow[] }).rows;
}
