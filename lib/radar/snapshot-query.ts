import "server-only";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { env } from "@/lib/env";
import { getActiveSession } from "@/lib/db/repos/auto-sessions";
import { fetchHeartbeats } from "@/lib/runtime/worker-heartbeat-db";
import {
  RADAR_WINDOWS,
  composeRadarSnapshot,
  type GateRow,
  type IngestedRow,
  type PositionRow,
  type RadarEventStage,
  type RadarSnapshot,
  type RadarWindow,
  type ScoredRow,
} from "@/lib/radar/snapshot";

/**
 * Reads one radar window from the tables each stage already writes (lib/radar/snapshot.ts decides what the rows
 * mean):
 *   ingested            events         first trade the ingestor stored for a coin
 *   scored / avoid      decision_log   the intelligence lane's verdicts
 *   gates and skips     radar_events   what the auto-trader decided about each BUY candidate
 *   entry, exit, outcome paper_positions / live_trades (auto-trade positions only, no shadows)
 */
type Rows<T> = { rows: T[] };
const rowsOf = <T>(res: unknown): T[] => (res as Rows<T>).rows;
const toIso = (v: Date | string | null): string | null => (v == null ? null : new Date(v).toISOString());
const num = (v: number | string | null): number | null => {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

export async function fetchRadarSnapshot(window: RadarWindow): Promise<RadarSnapshot> {
  const seconds = RADAR_WINDOWS[window];
  const since = sql`now() - ${seconds}::int * interval '1 second'`;
  const db = getDb();

  const [ingestedRes, scoredRes, gatesRes, paperRes, liveRes, active, beats] = await Promise.all([
    db.execute(sql`
      WITH win AS (
        SELECT mint, min(ts) AS first_ts
        FROM events
        WHERE ts > ${since} AND mint IS NOT NULL
        GROUP BY mint
      )
      SELECT w.mint, w.first_ts AS ts
      FROM win w
      WHERE NOT EXISTS (SELECT 1 FROM events p WHERE p.mint = w.mint AND p.ts <= ${since})
      LIMIT 20000
    `),
    db.execute(sql`
      SELECT mint,
        max(ts) AS ts,
        max(confluence_score)::float8 AS score,
        bool_or(action LIKE 'BUY%') AS bought,
        (array_agg(reason_human ORDER BY ts DESC) FILTER (WHERE action NOT LIKE 'BUY%'))[1] AS avoid_reason
      FROM decision_log
      WHERE ts > ${since}
      GROUP BY mint
      LIMIT 20000
    `),
    db.execute(sql`
      SELECT mint, ts, stage, sub_stage, score::float8 AS score, detail
      FROM radar_events
      WHERE ts > ${since}
      ORDER BY ts
      LIMIT 50000
    `),
    db.execute(sql`
      SELECT p.mint, p.opened_at, p.closed_at, p.close_reason AS exit_reason,
        p.realized_pnl_sol::float8 AS pnl_sol, d.confluence_score::float8 AS score,
        (p.opened_at > ${since}) AS opened_in_window,
        (p.closed_at IS NOT NULL AND p.closed_at > ${since}) AS closed_in_window
      FROM paper_positions p
      LEFT JOIN decision_log d ON d.id = p.decision_id
      WHERE COALESCE(p.entry_features->>'auto', 'true') = 'true'
        AND p.entry_features->>'shadow_of' IS NULL
        AND p.state IN ('INTENT', 'OPEN', 'CLOSING', 'CLOSED')
        AND (p.opened_at > ${since} OR p.closed_at > ${since} OR p.state <> 'CLOSED')
      LIMIT 5000
    `),
    db.execute(sql`
      SELECT l.mint, l.opened_at, l.closed_at, l.exit_reason, l.pnl_sol::float8 AS pnl_sol, l.dry_run,
        d.confluence_score::float8 AS score,
        (l.opened_at > ${since}) AS opened_in_window,
        (l.closed_at IS NOT NULL AND l.closed_at > ${since}) AS closed_in_window
      FROM live_trades l
      LEFT JOIN decision_log d
        ON d.id = CASE WHEN l.entry_features->>'decisionId' ~ '^[0-9]+$' THEN (l.entry_features->>'decisionId')::bigint END
      WHERE l.status <> 'failed'
        AND (l.opened_at > ${since} OR l.closed_at > ${since}
             OR (l.closed_at IS NULL AND l.status IN ('pending', 'open', 'pending_close', 'close_failed')))
      LIMIT 5000
    `),
    getActiveSession().catch(() => null),
    fetchHeartbeats().catch(() => []),
  ]);

  const ingested: IngestedRow[] = rowsOf<{ mint: string; ts: Date }>(ingestedRes).map((r) => ({
    mint: r.mint,
    ts: new Date(r.ts).toISOString(),
  }));
  const scored: ScoredRow[] = rowsOf<{ mint: string; ts: Date; score: number | null; bought: boolean; avoid_reason: string | null }>(
    scoredRes,
  ).map((r) => ({ mint: r.mint, ts: new Date(r.ts).toISOString(), score: num(r.score), bought: r.bought, avoidReason: r.avoid_reason }));
  const gates: GateRow[] = rowsOf<{ mint: string; ts: Date; stage: RadarEventStage; sub_stage: string | null; score: number | null; detail: string | null }>(
    gatesRes,
  ).map((r) => ({ mint: r.mint, ts: new Date(r.ts).toISOString(), stage: r.stage, sub_stage: r.sub_stage, score: num(r.score), detail: r.detail }));

  type PosRaw = {
    mint: string;
    opened_at: Date;
    closed_at: Date | null;
    exit_reason: string | null;
    pnl_sol: number | null;
    score: number | null;
    opened_in_window: boolean;
    closed_in_window: boolean;
    dry_run?: boolean;
  };
  const toPosition = (lane: "paper" | "live") => (r: PosRaw): PositionRow => ({
    mint: r.mint,
    lane,
    openedAt: new Date(r.opened_at).toISOString(),
    closedAt: toIso(r.closed_at),
    openedInWindow: r.opened_in_window,
    closedInWindow: r.closed_in_window,
    exitReason: r.exit_reason,
    pnlSol: num(r.pnl_sol),
    score: num(r.score),
    dryRun: r.dry_run === true,
  });
  const positions = [...rowsOf<PosRaw>(paperRes).map(toPosition("paper")), ...rowsOf<PosRaw>(liveRes).map(toPosition("live"))];

  const now = Date.now();
  const timeout = env().WORKER_HEARTBEAT_TIMEOUT_MS;
  const workerAlive = beats.some(
    (b) =>
      (b.name === "auto-trader" || b.name === "intelligence-commit" || b.name === "ingestor") &&
      now - new Date(b.lastBeat).getTime() < timeout,
  );

  return composeRadarSnapshot(
    { ingested, scored, gates, positions },
    {
      window,
      generatedAt: new Date(now).toISOString(),
      bot: { running: active != null, mode: active?.mode ?? null, workerAlive },
    },
  );
}
