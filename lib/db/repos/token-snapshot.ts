import "server-only";

import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";

export type TokenSnapshotDto = {
  mint: string;
  symbol: string | null;
  name: string | null;
  vSol: number | null;
  gradScore: number | null;
  rugScore: number | null;
  momentumScore: number | null;
  confluenceScore: number | null;
  lastAction: string | null;
  lastActionTs: string | null;
  buyers1h: number | null;
};

export async function fetchTokenSnapshot(mint: string): Promise<TokenSnapshotDto> {
  const res = await getDb().execute(sql`
    WITH latest_feat AS (
      SELECT *
      FROM token_features
      WHERE mint = ${mint}
      ORDER BY ts DESC
      LIMIT 1
    ),
    latest_dec AS (
      SELECT action, ts
      FROM decision_log
      WHERE mint = ${mint}
      ORDER BY ts DESC
      LIMIT 1
    ),
    last_ev AS (
      SELECT v_sol_after::float8 AS v
      FROM events
      WHERE mint = ${mint} AND v_sol_after IS NOT NULL
      ORDER BY ts DESC
      LIMIT 1
    ),
    buyers AS (
      SELECT COUNT(DISTINCT wallet)::int AS n
      FROM events
      WHERE mint = ${mint} AND kind = 'buy' AND ts > now() - interval '1 hour'
    )
    SELECT
      t.mint::text AS mint,
      t.symbol::text AS symbol,
      t.name::text AS name,
      COALESCE(lf.v_sol, le.v)::float8 AS v_sol,
      lf.grad_score::float8 AS grad_score,
      lf.rug_score::float8 AS rug_score,
      lf.momentum_score::float8 AS momentum_score,
      lf.confluence_score::float8 AS confluence_score,
      ld.action::text AS last_action,
      to_char(ld.ts, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS last_action_ts,
      b.n::int AS buyers_1h
    FROM (SELECT ${mint}::text AS mint) base
    LEFT JOIN tokens t ON t.mint = base.mint
    LEFT JOIN latest_feat lf ON true
    LEFT JOIN last_ev le ON true
    LEFT JOIN latest_dec ld ON true
    LEFT JOIN buyers b ON true
  `);
  type Row = {
    mint: string;
    symbol: string | null;
    name: string | null;
    v_sol: number | null;
    grad_score: number | null;
    rug_score: number | null;
    momentum_score: number | null;
    confluence_score: number | null;
    last_action: string | null;
    last_action_ts: string | null;
    buyers_1h: number | null;
  };
  const row = (res as unknown as { rows: Row[] }).rows[0];
  return {
    mint,
    symbol: row?.symbol ?? null,
    name: row?.name ?? null,
    vSol: row?.v_sol ?? null,
    gradScore: row?.grad_score ?? null,
    rugScore: row?.rug_score ?? null,
    momentumScore: row?.momentum_score ?? null,
    confluenceScore: row?.confluence_score ?? null,
    lastAction: row?.last_action ?? null,
    lastActionTs: row?.last_action_ts ?? null,
    buyers1h: row?.buyers_1h ?? null,
  };
}
