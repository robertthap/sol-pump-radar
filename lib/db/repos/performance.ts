import "server-only";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { PAPER_TRADES_READ } from "@/lib/db/paper-read";

export type OverallStats = {
  trades: number;
  wins: number;
  losses: number;
  winRate: number | null;
  totalPnlSol: number;
  avgPnlSol: number | null;
  avgWinSol: number | null;
  avgLossSol: number | null;
  expectancySol: number | null;
  bestPnlSol: number | null;
  worstPnlSol: number | null;
  avgHoldSeconds: number | null;
};

export type ByExitReasonRow = {
  reason: string;
  count: number;
  avgPnlSol: number;
  totalPnlSol: number;
  share: number;
};

export type ByActionRow = {
  action: string;
  count: number;
  wins: number;
  winRate: number | null;
  totalPnlSol: number;
  avgPnlSol: number;
};

export type ByScoreBucketRow = {
  bucket: string;
  lo: number;
  hi: number;
  count: number;
  wins: number;
  winRate: number | null;
  avgPnlSol: number;
};

export async function fetchOverall(): Promise<OverallStats> {
  const res = await getDb().execute(sql`
    SELECT
      COUNT(*)::int AS trades,
      COUNT(*) FILTER (WHERE pnl_sol > 0)::int AS wins,
      COUNT(*) FILTER (WHERE pnl_sol <= 0)::int AS losses,
      COALESCE(SUM(pnl_sol), 0)::float8 AS total_pnl,
      AVG(pnl_sol)::float8 AS avg_pnl,
      AVG(pnl_sol) FILTER (WHERE pnl_sol > 0)::float8 AS avg_win,
      AVG(pnl_sol) FILTER (WHERE pnl_sol <= 0)::float8 AS avg_loss,
      MAX(pnl_sol)::float8 AS best,
      MIN(pnl_sol)::float8 AS worst,
      AVG(EXTRACT(EPOCH FROM (closed_at - opened_at)))::float8 AS avg_hold_seconds
    FROM ${sql.raw(PAPER_TRADES_READ)}
    WHERE status = 'closed'
  `);
  type Raw = {
    trades: number;
    wins: number;
    losses: number;
    total_pnl: number;
    avg_pnl: number | null;
    avg_win: number | null;
    avg_loss: number | null;
    best: number | null;
    worst: number | null;
    avg_hold_seconds: number | null;
  };
  const r = (res as unknown as { rows: Raw[] }).rows[0];
  if (!r || r.trades === 0) {
    return {
      trades: 0,
      wins: 0,
      losses: 0,
      winRate: null,
      totalPnlSol: 0,
      avgPnlSol: null,
      avgWinSol: null,
      avgLossSol: null,
      expectancySol: null,
      bestPnlSol: null,
      worstPnlSol: null,
      avgHoldSeconds: null,
    };
  }
  const winRate = r.wins / r.trades;
  const expectancy =
    r.avg_win != null && r.avg_loss != null
      ? winRate * r.avg_win + (1 - winRate) * r.avg_loss
      : r.avg_pnl;
  return {
    trades: r.trades,
    wins: r.wins,
    losses: r.losses,
    winRate,
    totalPnlSol: r.total_pnl,
    avgPnlSol: r.avg_pnl,
    avgWinSol: r.avg_win,
    avgLossSol: r.avg_loss,
    expectancySol: expectancy,
    bestPnlSol: r.best,
    worstPnlSol: r.worst,
    avgHoldSeconds: r.avg_hold_seconds,
  };
}

export async function fetchByExitReason(): Promise<ByExitReasonRow[]> {
  const res = await getDb().execute(sql`
    WITH totals AS (
      SELECT COUNT(*)::float8 AS total FROM ${sql.raw(PAPER_TRADES_READ)} WHERE status = 'closed'
    )
    SELECT
      COALESCE(exit_reason, 'unknown')::text AS reason,
      COUNT(*)::int AS count,
      COALESCE(AVG(pnl_sol), 0)::float8 AS avg_pnl,
      COALESCE(SUM(pnl_sol), 0)::float8 AS total_pnl,
      (COUNT(*)::float8 / NULLIF((SELECT total FROM totals), 0))::float8 AS share
    FROM ${sql.raw(PAPER_TRADES_READ)}
    WHERE status = 'closed'
    GROUP BY exit_reason
    ORDER BY count DESC
  `);
  type Raw = {
    reason: string;
    count: number;
    avg_pnl: number;
    total_pnl: number;
    share: number | null;
  };
  return (res as unknown as { rows: Raw[] }).rows.map((r) => ({
    reason: r.reason,
    count: r.count,
    avgPnlSol: r.avg_pnl,
    totalPnlSol: r.total_pnl,
    share: r.share ?? 0,
  }));
}

export async function fetchByAction(): Promise<ByActionRow[]> {
  const res = await getDb().execute(sql`
    SELECT
      COALESCE(entry_features->>'action', 'UNKNOWN')::text AS action,
      COUNT(*)::int AS count,
      COUNT(*) FILTER (WHERE pnl_sol > 0)::int AS wins,
      COALESCE(SUM(pnl_sol), 0)::float8 AS total_pnl,
      COALESCE(AVG(pnl_sol), 0)::float8 AS avg_pnl
    FROM ${sql.raw(PAPER_TRADES_READ)}
    WHERE status = 'closed'
    GROUP BY 1
    ORDER BY count DESC
  `);
  type Raw = {
    action: string;
    count: number;
    wins: number;
    total_pnl: number;
    avg_pnl: number;
  };
  return (res as unknown as { rows: Raw[] }).rows.map((r) => ({
    action: r.action,
    count: r.count,
    wins: r.wins,
    winRate: r.count > 0 ? r.wins / r.count : null,
    totalPnlSol: r.total_pnl,
    avgPnlSol: r.avg_pnl,
  }));
}

const BUCKETS = [
  { lo: 0.4, hi: 0.55, label: "0.40-0.55" },
  { lo: 0.55, hi: 0.65, label: "0.55-0.65" },
  { lo: 0.65, hi: 0.75, label: "0.65-0.75" },
  { lo: 0.75, hi: 0.85, label: "0.75-0.85" },
  { lo: 0.85, hi: 1.01, label: "0.85+" },
];

async function bucketed(field: "M1_GRADUATION" | "M3_RUG"): Promise<ByScoreBucketRow[]> {
  const path = field;
  const res = await getDb().execute(sql`
    SELECT
      (modules_at_entry->>${path})::float8 AS score,
      pnl_sol::float8 AS pnl_sol
    FROM ${sql.raw(PAPER_TRADES_READ)}
    WHERE status = 'closed'
      AND modules_at_entry ? ${path}
  `);
  type Raw = { score: number | null; pnl_sol: number | null };
  const rows = (res as unknown as { rows: Raw[] }).rows;
  const out: ByScoreBucketRow[] = BUCKETS.map((b) => ({
    bucket: b.label,
    lo: b.lo,
    hi: b.hi,
    count: 0,
    wins: 0,
    winRate: null,
    avgPnlSol: 0,
  }));
  for (const r of rows) {
    if (r.score == null || r.pnl_sol == null) continue;
    const idx = BUCKETS.findIndex((b) => r.score! >= b.lo && r.score! < b.hi);
    if (idx === -1) continue;
    const b = out[idx]!;
    b.count++;
    if (r.pnl_sol > 0) b.wins++;
    b.avgPnlSol += r.pnl_sol;
  }
  for (const b of out) {
    if (b.count > 0) {
      b.avgPnlSol = b.avgPnlSol / b.count;
      b.winRate = b.wins / b.count;
    }
  }
  return out;
}

export async function fetchByGradBucket(): Promise<ByScoreBucketRow[]> {
  return bucketed("M1_GRADUATION");
}

export async function fetchByRugBucket(): Promise<ByScoreBucketRow[]> {
  return bucketed("M3_RUG");
}

/** Closed paper trades from auto-trader sessions only (filtered entries). */
export async function fetchAutoPaperOverall(hours = 168): Promise<OverallStats> {
  const res = await getDb().execute(sql`
    SELECT
      COUNT(*)::int AS trades,
      COUNT(*) FILTER (WHERE pnl_sol > 0)::int AS wins,
      COUNT(*) FILTER (WHERE pnl_sol <= 0)::int AS losses,
      COALESCE(SUM(pnl_sol), 0)::float8 AS total_pnl,
      AVG(pnl_sol)::float8 AS avg_pnl,
      AVG(pnl_sol) FILTER (WHERE pnl_sol > 0)::float8 AS avg_win,
      AVG(pnl_sol) FILTER (WHERE pnl_sol <= 0)::float8 AS avg_loss,
      MAX(pnl_sol)::float8 AS best,
      MIN(pnl_sol)::float8 AS worst,
      AVG(EXTRACT(EPOCH FROM (closed_at - opened_at)))::float8 AS avg_hold_seconds
    FROM ${sql.raw(PAPER_TRADES_READ)}
    WHERE status = 'closed'
      AND entry_features->>'auto' = 'true'
      AND entry_features->>'session_id' IS NOT NULL
      AND closed_at > now() - (${sql.raw(String(hours))} || ' hours')::interval
  `);
  type Raw = {
    trades: number;
    wins: number;
    losses: number;
    total_pnl: number;
    avg_pnl: number | null;
    avg_win: number | null;
    avg_loss: number | null;
    best: number | null;
    worst: number | null;
    avg_hold_seconds: number | null;
  };
  const r = (res as unknown as { rows: Raw[] }).rows[0];
  if (!r || r.trades === 0) {
    return {
      trades: 0,
      wins: 0,
      losses: 0,
      winRate: null,
      totalPnlSol: 0,
      avgPnlSol: null,
      avgWinSol: null,
      avgLossSol: null,
      expectancySol: null,
      bestPnlSol: null,
      worstPnlSol: null,
      avgHoldSeconds: null,
    };
  }
  const winRate = r.wins / r.trades;
  const avgLoss = r.avg_loss ?? 0;
  const avgWin = r.avg_win ?? 0;
  const expectancy = winRate * avgWin + (1 - winRate) * avgLoss;
  return {
    trades: r.trades,
    wins: r.wins,
    losses: r.losses,
    winRate,
    totalPnlSol: r.total_pnl,
    avgPnlSol: r.avg_pnl,
    avgWinSol: r.avg_win,
    avgLossSol: r.avg_loss,
    expectancySol: expectancy,
    bestPnlSol: r.best,
    worstPnlSol: r.worst,
    avgHoldSeconds: r.avg_hold_seconds,
  };
}

type ClosedPaperAggRow = {
  trades: number;
  wins: number;
  losses: number;
  total_pnl: number;
  avg_pnl: number | null;
  avg_win: number | null;
  avg_loss: number | null;
  best: number | null;
  worst: number | null;
  avg_hold_seconds: number | null;
};

function mapClosedPaperAgg(r: ClosedPaperAggRow | undefined): OverallStats {
  if (!r || r.trades === 0) {
    return {
      trades: 0,
      wins: 0,
      losses: 0,
      winRate: null,
      totalPnlSol: 0,
      avgPnlSol: null,
      avgWinSol: null,
      avgLossSol: null,
      expectancySol: null,
      bestPnlSol: null,
      worstPnlSol: null,
      avgHoldSeconds: null,
    };
  }
  const winRate = r.wins / r.trades;
  const avgLoss = r.avg_loss ?? 0;
  const avgWin = r.avg_win ?? 0;
  const expectancy = winRate * avgWin + (1 - winRate) * avgLoss;
  return {
    trades: r.trades,
    wins: r.wins,
    losses: r.losses,
    winRate,
    totalPnlSol: r.total_pnl,
    avgPnlSol: r.avg_pnl,
    avgWinSol: r.avg_win,
    avgLossSol: r.avg_loss,
    expectancySol: expectancy,
    bestPnlSol: r.best,
    worstPnlSol: r.worst,
    avgHoldSeconds: r.avg_hold_seconds,
  };
}

async function fetchClosedPaperAgg(extraFilter: ReturnType<typeof sql>, hours?: number): Promise<OverallStats> {
  const res = await getDb().execute(sql`
    SELECT
      COUNT(*)::int AS trades,
      COUNT(*) FILTER (WHERE pnl_sol > 0)::int AS wins,
      COUNT(*) FILTER (WHERE pnl_sol <= 0)::int AS losses,
      COALESCE(SUM(pnl_sol), 0)::float8 AS total_pnl,
      AVG(pnl_sol)::float8 AS avg_pnl,
      AVG(pnl_sol) FILTER (WHERE pnl_sol > 0)::float8 AS avg_win,
      AVG(pnl_sol) FILTER (WHERE pnl_sol <= 0)::float8 AS avg_loss,
      MAX(pnl_sol)::float8 AS best,
      MIN(pnl_sol)::float8 AS worst,
      AVG(EXTRACT(EPOCH FROM (closed_at - opened_at)))::float8 AS avg_hold_seconds
    FROM ${sql.raw(PAPER_TRADES_READ)}
    WHERE status = 'closed'
      AND ${extraFilter}
      AND (${hours == null ? sql`TRUE` : sql`closed_at > now() - (${sql.raw(String(hours))} || ' hours')::interval`})
  `);
  return mapClosedPaperAgg((res as unknown as { rows: ClosedPaperAggRow[] }).rows[0]);
}

/** Auto-trader paper trades for a given entry tier (strict|relaxed). */
export async function fetchTierOverall(
  tier: "strict" | "relaxed",
  hours = 168,
): Promise<OverallStats> {
  return fetchClosedPaperAgg(
    sql`entry_features->>'auto' = 'true'
        AND entry_features->>'session_id' IS NOT NULL
        AND entry_features->>'entry_tier' = ${tier}`,
    hours,
  );
}

/** Background shadow-learner paper trades (not user auto sessions). */
export async function fetchShadowLearnerOverall(hours = 168): Promise<OverallStats> {
  return fetchClosedPaperAgg(sql`entry_features->>'purpose' = 'shadow_learn'`, hours);
}

/** Manual demo / non-auto paper trades (excludes auto sessions and shadow learner). */
export async function fetchManualPaperOverall(hours = 168): Promise<OverallStats> {
  return fetchClosedPaperAgg(
    sql`(
      COALESCE(entry_features->>'purpose', '') <> 'shadow_learn'
      AND NOT (
        COALESCE(entry_features->>'auto', 'false') = 'true'
        AND entry_features->>'session_id' IS NOT NULL
      )
    )`,
    hours,
  );
}

export type PerformanceBreakdown = {
  allPaper: OverallStats;
  autoTrader: OverallStats;
  shadowLearner: OverallStats;
  manualPaper: OverallStats;
};

export async function fetchPerformanceBreakdown(hours = 168): Promise<PerformanceBreakdown> {
  const [allPaper, autoTrader, shadowLearner, manualPaper] = await Promise.all([
    fetchOverall(),
    fetchAutoPaperOverall(hours),
    fetchShadowLearnerOverall(hours),
    fetchManualPaperOverall(hours),
  ]);
  return { allPaper, autoTrader, shadowLearner, manualPaper };
}
