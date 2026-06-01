import "server-only";

import { sql } from "drizzle-orm";

import { getDb } from "@/lib/db/client";

import type { EngineBResult } from "@/lib/continuation/types";



export async function upsertContinuationCandidate(row: {

  mint: string;

  continuationScore: number;

  trendRank: number;

  source: string;

  dexH24Pct: number | null;

  liqUsd: number;

  alertAction: string | null;

  momentumState?: string;

  rankPercentile?: number;

  volRankPercentile?: number;

  liqRankPercentile?: number;

  rankVelocity?: number;

  stateConfidence?: number;

  pBreakout?: number;

  pExhaustion?: number;

  pContinuation?: number;

  engineBAction?: string;

  engineBJson?: EngineBResult;

}): Promise<void> {

  await getDb().execute(sql`

    INSERT INTO continuation_candidates (

      mint, continuation_score, trend_rank, source, dex_h24_pct, liq_usd, alert_action,

      momentum_state, rank_percentile, vol_rank_percentile, liq_rank_percentile,

      rank_velocity, state_confidence, p_breakout, p_exhaustion, p_continuation,

      engine_b_action, engine_b_json, updated_at

    )

    VALUES (

      ${row.mint},

      ${row.continuationScore},

      ${row.trendRank},

      ${row.source},

      ${row.dexH24Pct},

      ${row.liqUsd},

      ${row.alertAction},

      ${row.momentumState ?? null},

      ${row.rankPercentile ?? null},

      ${row.volRankPercentile ?? null},

      ${row.liqRankPercentile ?? null},

      ${row.rankVelocity ?? null},

      ${row.stateConfidence ?? null},

      ${row.pBreakout ?? null},

      ${row.pExhaustion ?? null},

      ${row.pContinuation ?? null},

      ${row.engineBAction ?? null},

      ${row.engineBJson ? JSON.stringify(row.engineBJson) : null}::jsonb,

      now()

    )

    ON CONFLICT (mint) DO UPDATE SET

      continuation_score = EXCLUDED.continuation_score,

      trend_rank = EXCLUDED.trend_rank,

      source = EXCLUDED.source,

      dex_h24_pct = EXCLUDED.dex_h24_pct,

      liq_usd = EXCLUDED.liq_usd,

      alert_action = EXCLUDED.alert_action,

      momentum_state = EXCLUDED.momentum_state,

      rank_percentile = EXCLUDED.rank_percentile,

      vol_rank_percentile = EXCLUDED.vol_rank_percentile,

      liq_rank_percentile = EXCLUDED.liq_rank_percentile,

      rank_velocity = EXCLUDED.rank_velocity,

      state_confidence = EXCLUDED.state_confidence,

      p_breakout = EXCLUDED.p_breakout,

      p_exhaustion = EXCLUDED.p_exhaustion,

      p_continuation = EXCLUDED.p_continuation,

      engine_b_action = EXCLUDED.engine_b_action,

      engine_b_json = EXCLUDED.engine_b_json,

      updated_at = now()

  `);

}



export async function fetchRecentContinuationMints(maxAgeMinutes = 30): Promise<string[]> {

  const res = await getDb().execute(sql`

    SELECT mint::text AS mint

    FROM continuation_candidates

    WHERE updated_at > now() - (${sql.raw(String(maxAgeMinutes))} || ' minutes')::interval

    ORDER BY continuation_score DESC

  `);

  return (res as unknown as { rows: Array<{ mint: string }> }).rows.map((r) => r.mint);

}



export async function fetchContinuationUniverseStats() {

  const res = await getDb().execute(sql`

    SELECT

      COUNT(*)::int AS total,

      COUNT(*) FILTER (WHERE continuation_score >= 0.38)::int AS alert_ready,

      MAX(updated_at) AS last_updated

    FROM continuation_candidates

    WHERE updated_at > now() - interval '30 minutes'

  `);

  return (res as unknown as {

    rows: Array<{ total: number; alert_ready: number; last_updated: string | null }>;

  }).rows[0];

}

export async function fetchContinuationCandidateByMint(
  mint: string,
): Promise<Record<string, unknown> | null> {
  const res = await getDb().execute(sql`
    SELECT momentum_state, rank_percentile, rank_velocity, continuation_score, engine_b_action
    FROM continuation_candidates
    WHERE mint = ${mint}
    LIMIT 1
  `);
  return (res as unknown as { rows: Array<Record<string, unknown>> }).rows[0] ?? null;
}

export async function fetchTopContinuationCandidates(limit = 15) {
  const res = await getDb().execute(sql`
    SELECT
      c.mint,
      c.continuation_score,
      c.alert_action,
      c.dex_h24_pct,
      c.liq_usd,
      c.trend_rank,
      c.momentum_state,
      c.rank_percentile,
      c.rank_velocity,
      c.engine_b_action,
      c.p_breakout,
      c.p_exhaustion,
      m.symbol
    FROM continuation_candidates c
    LEFT JOIN mint_registry m ON m.mint = c.mint
    WHERE c.updated_at > now() - interval '30 minutes'
    ORDER BY c.continuation_score DESC
    LIMIT ${limit}
  `);
  return (res as unknown as { rows: unknown[] }).rows;
}


