import "server-only";
import { sql } from "drizzle-orm";
import { logger } from "@/lib/log";
import { getDb } from "@/lib/db/client";
import { upsertRugLabel } from "@/lib/db/repos/rug-labels";

const log = logger("rug-labeler");

/**
 * Inactivity-based rug labeler — implements Kalacheva et al. (2026, §4.2).
 *
 * Algorithm:
 *   For each mint that's at least MIN_AGE_SECONDS old (so we don't label
 *   tokens that just haven't started trading yet):
 *     1. Find its first and last event timestamps + peak v_sol + final v_sol
 *     2. Compute inactivity = now - last_event_ts
 *     3. If inactivity >= INACTIVITY_RUGGED_SEC → label "rugged"
 *        elif inactivity >= INACTIVITY_STALLED_SEC → label "stalled"
 *        else → label "active"
 *   Tokens that are graduated to a real AMM pool (raydium/etc) are skipped.
 *
 * Reference (Kalacheva §4.2): "A token is considered to have become a rug
 * pull at time T with inactivity interval δT if there is an inactivity
 * interval of at least length δT before T". They use δT = 1h with T = 2 weeks
 * on Ethereum. Pump.fun curves are faster — we use δT = 10min by default.
 */
const TICK_MS = 5 * 60_000;
const FIRST_DELAY_MS = 30_000;
const MIN_AGE_SECONDS = 600; // don't label coins under 10 minutes old
const INACTIVITY_RUGGED_SEC = 600; // 10 min silence ⇒ rugged
const INACTIVITY_STALLED_SEC = 180; // 3-10 min silence ⇒ stalled
const MAX_AGE_HOURS = 48; // only consider mints created within last 48h

type Stats = { rugged: number; stalled: number; active: number };

async function tickOnce(): Promise<Stats> {
  const stats: Stats = { rugged: 0, stalled: 0, active: 0 };
  // Pull mints with their first/last events + peak.
  const r = await getDb().execute(sql`
    WITH cand AS (
      SELECT t.mint::text AS mint, t.created_at, t.status::text AS status
      FROM tokens t
      WHERE t.created_at > now() - ${sql.raw(`'${MAX_AGE_HOURS} hours'::interval`)}
        AND EXTRACT(EPOCH FROM (now() - t.created_at)) >= ${MIN_AGE_SECONDS}
        AND COALESCE(t.status, '') NOT IN ('graduated','completed')
    ),
    agg AS (
      SELECT
        e.mint::text AS mint,
        MIN(e.ts) AS first_ts,
        MAX(e.ts) AS last_ts,
        MAX(e.v_sol_after)::float8 AS peak_v_sol,
        COUNT(*) FILTER (WHERE e.kind IN ('buy','sell'))::int AS trades,
        COUNT(DISTINCT e.wallet) FILTER (WHERE e.kind = 'buy')::int AS unique_buyers,
        (SELECT v_sol_after::float8 FROM events e2 WHERE e2.mint = e.mint AND e2.v_sol_after IS NOT NULL ORDER BY ts DESC LIMIT 1) AS final_v_sol
      FROM events e
      WHERE e.mint IN (SELECT mint FROM cand)
      GROUP BY e.mint
    )
    SELECT c.mint, c.created_at, c.status,
           a.first_ts, a.last_ts, a.peak_v_sol, a.trades, a.unique_buyers, a.final_v_sol,
           EXTRACT(EPOCH FROM (now() - a.last_ts))::float8 AS inactivity_sec
    FROM cand c
    LEFT JOIN agg a ON a.mint = c.mint
    WHERE a.last_ts IS NOT NULL
    ORDER BY c.created_at DESC
    LIMIT 2000
  `);
  type Row = {
    mint: string;
    created_at: Date | string;
    status: string;
    first_ts: Date | string | null;
    last_ts: Date | string | null;
    peak_v_sol: number | null;
    trades: number | null;
    unique_buyers: number | null;
    final_v_sol: number | null;
    inactivity_sec: number | null;
  };
  const rows = (r as unknown as { rows: Row[] }).rows;
  for (const row of rows) {
    const inactivity = row.inactivity_sec ?? 0;
    let label: "rugged" | "stalled" | "active";
    let reason = "";
    if (inactivity >= INACTIVITY_RUGGED_SEC) {
      label = "rugged";
      reason = `no swaps for ${Math.round(inactivity / 60)}m (Kalacheva §4.2 inactivity criterion)`;
      stats.rugged++;
    } else if (inactivity >= INACTIVITY_STALLED_SEC) {
      label = "stalled";
      reason = `no swaps for ${Math.round(inactivity / 60)}m — momentum stalled`;
      stats.stalled++;
    } else {
      label = "active";
      reason = "still trading";
      stats.active++;
    }
    const peak = row.peak_v_sol;
    const final = row.final_v_sol;
    const drawdown = peak && peak > 0 && final != null ? (final - peak) / peak : null;
    await upsertRugLabel({
      mint: row.mint,
      label,
      lastEventAt: row.last_ts ? new Date(row.last_ts) : null,
      inactivitySeconds: Math.round(inactivity),
      peakVSol: peak,
      finalVSol: final,
      drawdown,
      trades: row.trades ?? 0,
      uniqueBuyers: row.unique_buyers ?? 0,
      reason,
      evidence: {
        firstTs: row.first_ts ? String(row.first_ts) : null,
        lastTs: row.last_ts ? String(row.last_ts) : null,
        ageSeconds: row.created_at
          ? (Date.now() - new Date(row.created_at).getTime()) / 1000
          : null,
      },
    });
  }
  return stats;
}

export async function startRugLabeler() {
  log.info("rug-labeler starting", {
    tickMs: TICK_MS,
    ruggedSec: INACTIVITY_RUGGED_SEC,
    stalledSec: INACTIVITY_STALLED_SEC,
  });
  async function tick() {
    try {
      const s = await tickOnce();
      if (s.rugged + s.stalled + s.active > 0) {
        log.info("rug labels updated", s);
      }
    } catch (e) {
      log.warn("tick failed", { err: String(e) });
    }
  }
  setTimeout(() => tick().catch(() => undefined), FIRST_DELAY_MS);
  const interval = setInterval(() => tick().catch(() => undefined), TICK_MS);
  return () => clearInterval(interval);
}
