import "server-only";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { PAPER_TRADES_READ } from "@/lib/db/paper-read";
import { env } from "@/lib/env";

const VALID_WINDOWS = new Set([1, 6, 24, 24 * 7, 24 * 30, 24 * 365]);
function safeHours(h: number): number {
  if (!Number.isFinite(h) || h <= 0) return 24;
  if (VALID_WINDOWS.has(Math.floor(h))) return Math.floor(h);
  return 24;
}

export type EquityPoint = {
  ts: string;
  paperEquity: number;
  liveEquity: number;
  paperRealized: number;
  liveRealized: number;
};

export async function fetchEquityCurve(hours = 24, bucketMinutes = 5): Promise<EquityPoint[]> {
  const h = safeHours(hours);
  const bm = bucketMinutes <= 0 ? 5 : Math.min(120, Math.max(1, Math.floor(bucketMinutes)));
  const startSol = env().PAPER_START_SOL;
  const res = await getDb().execute(sql`
    WITH paper_closed AS (
      SELECT date_trunc('minute', closed_at)
        - make_interval(mins => (extract(minute from closed_at)::int % ${sql.raw(String(bm))})) AS bucket,
        SUM(pnl_sol)::float8 AS pnl
      FROM ${sql.raw(PAPER_TRADES_READ)}
      WHERE status = 'closed'
        AND closed_at IS NOT NULL
        AND closed_at > now() - (${sql.raw(String(h))} || ' hours')::interval
      GROUP BY 1
    ),
    live_closed AS (
      SELECT date_trunc('minute', closed_at)
        - make_interval(mins => (extract(minute from closed_at)::int % ${sql.raw(String(bm))})) AS bucket,
        SUM(pnl_sol)::float8 AS pnl
      FROM live_trades
      WHERE status = 'closed'
        AND closed_at IS NOT NULL
        AND closed_at > now() - (${sql.raw(String(h))} || ' hours')::interval
      GROUP BY 1
    ),
    grid AS (
      SELECT generate_series(
        date_trunc('minute', now() - (${sql.raw(String(h))} || ' hours')::interval),
        date_trunc('minute', now()),
        make_interval(mins => ${sql.raw(String(bm))})
      ) AS bucket
    )
    SELECT
      g.bucket AS ts,
      COALESCE(p.pnl, 0)::float8 AS paper_pnl,
      COALESCE(l.pnl, 0)::float8 AS live_pnl
    FROM grid g
    LEFT JOIN paper_closed p ON p.bucket = g.bucket
    LEFT JOIN live_closed l ON l.bucket = g.bucket
    ORDER BY g.bucket
  `);
  type Raw = { ts: Date | string; paper_pnl: number; live_pnl: number };
  const rows = (res as unknown as { rows: Raw[] }).rows;
  let pCum = 0;
  let lCum = 0;
  return rows.map((r) => {
    pCum += r.paper_pnl;
    lCum += r.live_pnl;
    return {
      ts: r.ts instanceof Date ? r.ts.toISOString() : String(r.ts),
      paperEquity: startSol + pCum,
      liveEquity: lCum,
      paperRealized: pCum,
      liveRealized: lCum,
    };
  });
}

export type DailyPnl = {
  date: string;
  paperPnl: number;
  livePnl: number;
  paperTrades: number;
  liveTrades: number;
};

export async function fetchDailyPnl(days = 14): Promise<DailyPnl[]> {
  const d = Math.max(1, Math.min(365, Math.floor(days)));
  const res = await getDb().execute(sql`
    WITH days AS (
      SELECT generate_series(
        date_trunc('day', now()) - (${sql.raw(String(d - 1))} || ' days')::interval,
        date_trunc('day', now()),
        '1 day'::interval
      )::date AS d
    ),
    paper AS (
      SELECT date_trunc('day', closed_at)::date AS d,
        SUM(pnl_sol)::float8 AS pnl,
        COUNT(*)::int AS n
      FROM ${sql.raw(PAPER_TRADES_READ)}
      WHERE status = 'closed'
        AND closed_at IS NOT NULL
        AND closed_at > now() - (${sql.raw(String(d))} || ' days')::interval
      GROUP BY 1
    ),
    live AS (
      SELECT date_trunc('day', closed_at)::date AS d,
        SUM(pnl_sol)::float8 AS pnl,
        COUNT(*)::int AS n
      FROM live_trades
      WHERE status = 'closed'
        AND closed_at IS NOT NULL
        AND closed_at > now() - (${sql.raw(String(d))} || ' days')::interval
      GROUP BY 1
    )
    SELECT to_char(days.d, 'YYYY-MM-DD') AS date,
      COALESCE(paper.pnl, 0)::float8 AS paper_pnl,
      COALESCE(paper.n, 0)::int AS paper_n,
      COALESCE(live.pnl, 0)::float8 AS live_pnl,
      COALESCE(live.n, 0)::int AS live_n
    FROM days
    LEFT JOIN paper ON paper.d = days.d
    LEFT JOIN live ON live.d = days.d
    ORDER BY days.d
  `);
  type Raw = {
    date: string;
    paper_pnl: number;
    paper_n: number;
    live_pnl: number;
    live_n: number;
  };
  const rows = (res as unknown as { rows: Raw[] }).rows;
  return rows.map((r) => ({
    date: r.date,
    paperPnl: r.paper_pnl,
    livePnl: r.live_pnl,
    paperTrades: r.paper_n,
    liveTrades: r.live_n,
  }));
}

export type TradeRow = {
  id: string;
  source: "paper" | "live";
  mint: string;
  symbol: string | null;
  status: string;
  sizeSol: number;
  entryPrice: number | null;
  exitPrice: number | null;
  pnlSol: number | null;
  pnlPct: number | null;
  exitReason: string | null;
  action: string | null;
  openedAt: string;
  closedAt: string | null;
  holdSeconds: number | null;
  modules: Record<string, number> | null;
};

export async function fetchTradeHistory(
  hours = 24 * 7,
  source: "all" | "paper" | "live" = "all",
  limit = 500,
): Promise<TradeRow[]> {
  const h = safeHours(hours);
  const lim = Math.max(10, Math.min(2000, Math.floor(limit)));
  const sourceFilter = source === "all" ? sql`TRUE` : source === "paper" ? sql`source = 'paper'` : sql`source = 'live'`;
  const res = await getDb().execute(sql`
    WITH all_trades AS (
      SELECT
        'paper'::text AS source,
        p.id::text AS id,
        p.mint::text AS mint,
        p.status::text AS status,
        p.size_sol::float8 AS size_sol,
        p.entry_v_sol::float8 AS entry_price,
        p.exit_v_sol::float8 AS exit_price,
        p.pnl_sol::float8 AS pnl_sol,
        p.exit_reason::text AS exit_reason,
        p.opened_at,
        p.closed_at,
        p.modules_at_entry AS modules,
        (p.entry_features->>'action')::text AS action
      FROM ${sql.raw(PAPER_TRADES_READ)} p
      WHERE p.opened_at > now() - (${sql.raw(String(h))} || ' hours')::interval
      UNION ALL
      SELECT
        'live'::text AS source,
        l.id::text AS id,
        l.mint::text AS mint,
        l.status::text AS status,
        l.size_sol::float8 AS size_sol,
        l.entry_price::float8 AS entry_price,
        l.exit_price::float8 AS exit_price,
        l.pnl_sol::float8 AS pnl_sol,
        l.exit_reason::text AS exit_reason,
        l.opened_at,
        l.closed_at,
        l.modules_at_entry AS modules,
        (l.entry_features->>'action')::text AS action
      FROM live_trades l
      WHERE l.opened_at > now() - (${sql.raw(String(h))} || ' hours')::interval
    )
    SELECT a.*,
      t.symbol::text AS symbol,
      EXTRACT(EPOCH FROM (COALESCE(a.closed_at, now()) - a.opened_at))::float8 AS hold_seconds
    FROM all_trades a
    LEFT JOIN tokens t ON t.mint = a.mint
    WHERE ${sourceFilter}
    ORDER BY a.opened_at DESC
    LIMIT ${sql.raw(String(lim))}
  `);
  type Raw = {
    source: "paper" | "live";
    id: string;
    mint: string;
    status: string;
    size_sol: number;
    entry_price: number | null;
    exit_price: number | null;
    pnl_sol: number | null;
    exit_reason: string | null;
    opened_at: Date | string;
    closed_at: Date | string | null;
    modules: Record<string, number> | null;
    action: string | null;
    symbol: string | null;
    hold_seconds: number | null;
  };
  const rows = (res as unknown as { rows: Raw[] }).rows;
  return rows.map((r) => ({
    id: r.id,
    source: r.source,
    mint: r.mint,
    symbol: r.symbol,
    status: r.status,
    sizeSol: r.size_sol,
    entryPrice: r.entry_price,
    exitPrice: r.exit_price,
    pnlSol: r.pnl_sol,
    pnlPct: r.pnl_sol != null && r.size_sol > 0 ? r.pnl_sol / r.size_sol : null,
    exitReason: r.exit_reason,
    action: r.action,
    openedAt: r.opened_at instanceof Date ? r.opened_at.toISOString() : String(r.opened_at),
    closedAt:
      r.closed_at == null
        ? null
        : r.closed_at instanceof Date
          ? r.closed_at.toISOString()
          : String(r.closed_at),
    holdSeconds: r.hold_seconds,
    modules: r.modules,
  }));
}

export type DistributionBucket = {
  bucket: string;
  loPct: number;
  hiPct: number;
  count: number;
};

export async function fetchPnlDistribution(hours = 24 * 7): Promise<DistributionBucket[]> {
  const h = safeHours(hours);
  const res = await getDb().execute(sql`
    WITH closed AS (
      SELECT pnl_sol::float8 / NULLIF(size_sol, 0) AS pct
      FROM ${sql.raw(PAPER_TRADES_READ)}
      WHERE status = 'closed'
        AND closed_at > now() - (${sql.raw(String(h))} || ' hours')::interval
      UNION ALL
      SELECT pnl_sol::float8 / NULLIF(size_sol, 0) AS pct
      FROM live_trades
      WHERE status = 'closed'
        AND closed_at > now() - (${sql.raw(String(h))} || ' hours')::interval
    )
    SELECT
      CASE
        WHEN pct < -0.5 THEN '< -50%'
        WHEN pct < -0.25 THEN '-50 to -25%'
        WHEN pct < -0.10 THEN '-25 to -10%'
        WHEN pct < 0 THEN '-10 to 0%'
        WHEN pct < 0.10 THEN '0 to +10%'
        WHEN pct < 0.25 THEN '+10 to +25%'
        WHEN pct < 0.50 THEN '+25 to +50%'
        WHEN pct < 1.00 THEN '+50 to +100%'
        ELSE '> +100%'
      END AS bucket,
      CASE
        WHEN pct < -0.5 THEN -2.0
        WHEN pct < -0.25 THEN -0.5
        WHEN pct < -0.10 THEN -0.25
        WHEN pct < 0 THEN -0.10
        WHEN pct < 0.10 THEN 0
        WHEN pct < 0.25 THEN 0.10
        WHEN pct < 0.50 THEN 0.25
        WHEN pct < 1.00 THEN 0.50
        ELSE 1.0
      END AS lo_pct,
      CASE
        WHEN pct < -0.5 THEN -0.5
        WHEN pct < -0.25 THEN -0.25
        WHEN pct < -0.10 THEN -0.10
        WHEN pct < 0 THEN 0.0
        WHEN pct < 0.10 THEN 0.10
        WHEN pct < 0.25 THEN 0.25
        WHEN pct < 0.50 THEN 0.50
        WHEN pct < 1.00 THEN 1.0
        ELSE 5.0
      END AS hi_pct,
      count(*)::int AS n
    FROM closed
    WHERE pct IS NOT NULL
    GROUP BY bucket, lo_pct, hi_pct
    ORDER BY lo_pct
  `);
  type Raw = { bucket: string; lo_pct: number; hi_pct: number; n: number };
  const rows = (res as unknown as { rows: Raw[] }).rows;
  return rows.map((r) => ({
    bucket: r.bucket,
    loPct: r.lo_pct,
    hiPct: r.hi_pct,
    count: r.n,
  }));
}

export type MintPerf = {
  mint: string;
  symbol: string | null;
  trades: number;
  wins: number;
  totalPnlSol: number;
};

export async function fetchTopMintPerformance(hours = 24 * 7, limit = 10): Promise<{
  winners: MintPerf[];
  losers: MintPerf[];
}> {
  const h = safeHours(hours);
  const lim = Math.max(3, Math.min(50, Math.floor(limit)));
  const res = await getDb().execute(sql`
    WITH all_closed AS (
      SELECT mint, pnl_sol::float8 AS pnl
      FROM ${sql.raw(PAPER_TRADES_READ)}
      WHERE status = 'closed' AND closed_at > now() - (${sql.raw(String(h))} || ' hours')::interval
      UNION ALL
      SELECT mint, pnl_sol::float8 AS pnl
      FROM live_trades
      WHERE status = 'closed' AND closed_at > now() - (${sql.raw(String(h))} || ' hours')::interval
    ),
    grouped AS (
      SELECT mint::text AS mint,
        count(*)::int AS trades,
        count(*) FILTER (WHERE pnl > 0)::int AS wins,
        SUM(pnl)::float8 AS total_pnl
      FROM all_closed
      GROUP BY mint
    )
    SELECT g.mint, g.trades, g.wins, g.total_pnl, t.symbol::text AS symbol
    FROM grouped g
    LEFT JOIN tokens t ON t.mint = g.mint
    ORDER BY g.total_pnl DESC NULLS LAST
  `);
  type Raw = {
    mint: string;
    trades: number;
    wins: number;
    total_pnl: number;
    symbol: string | null;
  };
  const rows = (res as unknown as { rows: Raw[] }).rows;
  const mapped: MintPerf[] = rows.map((r) => ({
    mint: r.mint,
    symbol: r.symbol,
    trades: r.trades,
    wins: r.wins,
    totalPnlSol: r.total_pnl,
  }));
  return {
    winners: mapped.filter((m) => m.totalPnlSol > 0).slice(0, lim),
    losers: mapped.filter((m) => m.totalPnlSol < 0).slice(-lim).reverse(),
  };
}

export type ShadowParityPair = {
  liveId: string;
  paperId: string;
  mint: string;
  sizeSol: number;
  route: string;
  dryRun: boolean;
  liveStatus: string;
  paperStatus: string;
  liveExit: string | null;
  paperExit: string | null;
  livePnl: number | null;
  paperPnl: number | null;
  slippageSol: number | null;
  bothClosed: boolean;
  liveOpened: string;
  liveClosed: string | null;
};

export async function fetchShadowParityPairs(hours = 24): Promise<ShadowParityPair[]> {
  const h = Math.min(24 * 30, Math.max(1, Math.floor(hours)));
  const r = await getDb().execute(sql`
    WITH shadows AS (
      SELECT
        (entry_features ->> 'shadow_of')::bigint AS live_id,
        id::text          AS paper_id,
        mint::text        AS mint,
        size_sol::float8  AS size_sol,
        status            AS paper_status,
        pnl_sol::float8   AS paper_pnl,
        opened_at         AS opened_at,
        closed_at         AS closed_at,
        exit_reason::text AS paper_exit
      FROM ${sql.raw(PAPER_TRADES_READ)}
      WHERE entry_features ? 'shadow_of'
        AND opened_at > now() - ${sql.raw(`'${h} hours'::interval`)}
    )
    SELECT
      lt.id::text       AS live_id,
      s.paper_id        AS paper_id,
      lt.mint::text     AS mint,
      lt.size_sol::float8 AS size_sol,
      lt.route::text    AS route,
      lt.dry_run        AS dry_run,
      lt.status         AS live_status,
      lt.pnl_sol::float8 AS live_pnl,
      lt.exit_reason::text AS live_exit,
      lt.opened_at      AS live_opened,
      lt.closed_at      AS live_closed,
      s.paper_status    AS paper_status,
      s.paper_pnl       AS paper_pnl,
      s.paper_exit      AS paper_exit,
      s.opened_at       AS paper_opened,
      s.closed_at       AS paper_closed
    FROM shadows s
    JOIN live_trades lt ON lt.id = s.live_id
    ORDER BY lt.opened_at DESC
    LIMIT 500
  `);
  type Raw = {
    live_id: string;
    paper_id: string;
    mint: string;
    size_sol: number;
    route: string;
    dry_run: boolean;
    live_status: string;
    live_pnl: number | null;
    live_exit: string | null;
    live_opened: Date | string;
    live_closed: Date | string | null;
    paper_status: string;
    paper_pnl: number | null;
    paper_exit: string | null;
  };
  return (r as unknown as { rows: Raw[] }).rows.map((row) => {
    const liveClosed = row.live_status === "closed";
    const paperClosed = row.paper_status === "closed";
    const bothClosed = liveClosed && paperClosed;
    const slippageSol =
      bothClosed && row.live_pnl != null && row.paper_pnl != null
        ? row.paper_pnl - row.live_pnl
        : null;
    return {
      liveId: row.live_id,
      paperId: row.paper_id,
      mint: row.mint,
      sizeSol: row.size_sol,
      route: row.route,
      dryRun: row.dry_run,
      liveStatus: row.live_status,
      paperStatus: row.paper_status,
      liveExit: row.live_exit,
      paperExit: row.paper_exit,
      livePnl: row.live_pnl,
      paperPnl: row.paper_pnl,
      slippageSol,
      bothClosed,
      liveOpened:
        row.live_opened instanceof Date ? row.live_opened.toISOString() : String(row.live_opened),
      liveClosed:
        row.live_closed instanceof Date
          ? row.live_closed.toISOString()
          : row.live_closed
            ? String(row.live_closed)
            : null,
    };
  });
}
