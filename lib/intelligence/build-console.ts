import "server-only";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { fetchIntelligenceFeedStats } from "@/lib/db/repos/intelligence-feed";
import { fetchContinuationUniverseStats } from "@/lib/db/repos/continuation-candidates";
import { getWorkerHeartbeats, getWorkerLastTickMs } from "@/lib/workers/heartbeat";
import { env } from "@/lib/env";
import { timedQuery } from "@/lib/db/query-metrics";
import type {
  CommitPulseRow,
  ConsolePayload,
  IntelEventRow,
} from "@/lib/mission/types";

export async function buildIntelligenceConsole(opts?: { lite?: boolean }): Promise<ConsolePayload> {
  const db = getDb();
  const lite = opts?.lite ?? false;

  const [stats, intelligence, arenaRes, heatRes] = await Promise.all([
    timedQuery("console:stats", () => fetchContinuationUniverseStats()),
    timedQuery("console:intel", () => fetchIntelligenceFeedStats()),
    timedQuery("console:arena", () =>
      db.execute(sql`
          SELECT
            c.mint,
            COALESCE(m.symbol, LEFT(c.mint, 6)) AS symbol,
            COALESCE(c.momentum_state, 'cold') AS state,
            COALESCE(c.rank_percentile, 0.5)::float AS rank_percentile,
            COALESCE(c.rank_velocity, 0)::float AS rank_velocity,
            COALESCE(c.continuation_score, 0)::float AS continuation_score,
            c.engine_b_action,
            c.alert_action,
            c.liq_usd,
            c.dex_h24_pct,
            c.updated_at
          FROM continuation_candidates c
          LEFT JOIN mint_registry m ON m.mint = c.mint
          WHERE c.updated_at > now() - interval '45 minutes'
          ORDER BY c.rank_percentile DESC NULLS LAST, c.continuation_score DESC
          LIMIT 25
        `),
    ),
    timedQuery("console:heatmap", () =>
      db.execute(sql`
          SELECT COALESCE(momentum_state, 'cold') AS state, COUNT(*)::int AS n
          FROM continuation_candidates
          WHERE updated_at > now() - interval '45 minutes'
          GROUP BY momentum_state
        `),
    ),
  ]);

  type ArenaRow = {
    mint: string;
    symbol: string;
    state: string;
    rank_percentile: number;
    rank_velocity: number;
    continuation_score: number;
    engine_b_action: string | null;
    alert_action: string | null;
    liq_usd: number;
    dex_h24_pct: number | null;
    updated_at: string;
  };

  const arena = (arenaRes as unknown as { rows: ArenaRow[] }).rows.map((r, i) => ({
    ...r,
    rank: i + 1,
  }));

  const heatmap = (heatRes as unknown as { rows: Array<{ state: string; n: number }> }).rows;

  let events: IntelEventRow[] = [];
  let recentCommits: CommitPulseRow[] = [];
  let rankSeries: ConsolePayload["rankSeries"] = [];

  if (!lite) {
    const [eventsRes, commitsRes, rankSeriesRes] = await Promise.all([
      timedQuery("console:events", () =>
        db.execute(sql`
          SELECT mint, kind, payload, ts
          FROM continuation_events
          WHERE ts > now() - interval '2 hours'
          ORDER BY ts DESC
          LIMIT 40
        `),
      ),
      timedQuery("console:commits", () =>
        db.execute(sql`
          SELECT
            dt.mint,
            COALESCE(m.symbol, LEFT(dt.mint, 6)) AS symbol,
            dt.ts,
            dt.feature_snapshot->'output'->>'state' AS state,
            (dt.feature_snapshot->'output'->>'rank_percentile')::float AS rank_percentile,
            dt.feature_snapshot->'output'->>'signal' AS signal,
            dt.reason
          FROM decision_trace dt
          LEFT JOIN mint_registry m ON m.mint = dt.mint
          WHERE dt.stage = 'intelligence_commit'
            AND dt.ts > now() - interval '3 hours'
          ORDER BY dt.ts DESC
          LIMIT 30
        `),
      ),
      timedQuery("console:rankSeries", () =>
        db.execute(sql`
          WITH top3 AS (
            SELECT mint
            FROM continuation_candidates
            WHERE updated_at > now() - interval '45 minutes'
            ORDER BY rank_percentile DESC NULLS LAST
            LIMIT 3
          )
          SELECT
            dt.mint,
            COALESCE(m.symbol, LEFT(dt.mint, 6)) AS symbol,
            dt.ts,
            (dt.feature_snapshot->'output'->>'rank_percentile')::float AS rank_pct
          FROM decision_trace dt
          INNER JOIN top3 t ON t.mint = dt.mint
          LEFT JOIN mint_registry m ON m.mint = dt.mint
          WHERE dt.stage = 'intelligence_commit'
            AND dt.ts > now() - interval '3 hours'
            AND dt.feature_snapshot->'output'->>'rank_percentile' IS NOT NULL
          ORDER BY dt.mint, dt.ts ASC
        `),
      ),
    ]);

    events = (eventsRes as unknown as { rows: IntelEventRow[] }).rows;
    recentCommits = (commitsRes as unknown as { rows: CommitPulseRow[] }).rows;

    const rawSeries = (rankSeriesRes as unknown as {
      rows: Array<{ mint: string; symbol: string; ts: Date | string; rank_pct: number }>;
    }).rows;

    const byMint = new Map<string, { symbol: string; points: Array<{ t: number; v: number }> }>();
    for (const row of rawSeries) {
      const t = row.ts instanceof Date ? row.ts.getTime() : new Date(row.ts).getTime();
      let bucket = byMint.get(row.mint);
      if (!bucket) {
        bucket = { symbol: row.symbol, points: [] };
        byMint.set(row.mint, bucket);
      }
      bucket.points.push({ t, v: row.rank_pct });
    }
    rankSeries = [...byMint.entries()].map(([mint, { symbol, points }]) => ({
      mint,
      symbol,
      points,
    }));
  }

  return {
    ts: Date.now(),
    workers: env().WORKERS,
    workerHeartbeats: getWorkerHeartbeats(),
    workerLastTickMs: getWorkerLastTickMs(),
    stats: stats ?? { total: 0, alert_ready: 0, last_updated: null },
    intelligence,
    arena,
    heatmap,
    events,
    recentCommits,
    rankSeries,
  };
}
