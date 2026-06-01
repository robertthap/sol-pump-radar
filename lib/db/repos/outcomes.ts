import "server-only";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { PAPER_TRADES_READ } from "@/lib/db/paper-read";
import { tradeOutcomes } from "@/lib/db/schema";
import { logger } from "@/lib/log";

const log = logger("repo:outcomes");

export type UnattributedTrade = {
  tradeId: bigint;
  mint: string;
  sizeSol: number;
  entryPrice: number | null;
  exitPrice: number | null;
  pnlSol: number | null;
  exitReason: string | null;
  modulesAtEntry: Record<string, number> | null;
  entryAction: string | null;
  entryConfluence: number | null;
  openedAt: Date | string;
  closedAt: Date | string | null;
};

export async function fetchUnattributedPaperTrades(limit = 200): Promise<UnattributedTrade[]> {
  const res = await getDb().execute(sql`
    SELECT
      p.id::text AS trade_id,
      p.mint::text AS mint,
      p.size_sol::float8 AS size_sol,
      p.entry_v_sol::float8 AS entry_price,
      p.exit_v_sol::float8 AS exit_price,
      p.pnl_sol::float8 AS pnl_sol,
      p.exit_reason::text AS exit_reason,
      p.modules_at_entry AS modules_at_entry,
      p.opened_at AS opened_at,
      p.closed_at AS closed_at,
      d.action::text AS entry_action,
      d.confluence_score::float8 AS entry_confluence
    FROM ${sql.raw(PAPER_TRADES_READ)} p
    LEFT JOIN trade_outcomes o
      ON o.source = 'paper' AND o.trade_id = p.id
    LEFT JOIN LATERAL (
      SELECT action, confluence_score
      FROM decision_log
      WHERE mint = p.mint
        AND executor_reason = ('paper_trade=' || p.id::text)
      ORDER BY ts ASC
      LIMIT 1
    ) d ON TRUE
    WHERE p.status = 'closed' AND o.id IS NULL
    ORDER BY p.closed_at ASC
    LIMIT ${sql.raw(String(limit))}
  `);
  type Raw = {
    trade_id: string;
    mint: string;
    size_sol: number;
    entry_price: number | null;
    exit_price: number | null;
    pnl_sol: number | null;
    exit_reason: string | null;
    modules_at_entry: Record<string, number> | null;
    opened_at: Date | string;
    closed_at: Date | string | null;
    entry_action: string | null;
    entry_confluence: number | null;
  };
  const rows = (res as unknown as { rows: Raw[] }).rows;
  return rows.map((r) => ({
    tradeId: BigInt(r.trade_id),
    mint: r.mint,
    sizeSol: r.size_sol,
    entryPrice: r.entry_price,
    exitPrice: r.exit_price,
    pnlSol: r.pnl_sol,
    exitReason: r.exit_reason,
    modulesAtEntry: r.modules_at_entry,
    entryAction: r.entry_action,
    entryConfluence: r.entry_confluence,
    openedAt: r.opened_at,
    closedAt: r.closed_at,
  }));
}

/**
 * Synchronous outcome recording — called by the trader the moment a position closes.
 * Provides the same data the periodic attribution worker would gather, but immediately.
 * Idempotent via UNIQUE (source, trade_id) — falls back to no-op on conflict.
 */
export async function recordOutcome(opts: {
  source: "paper" | "live";
  tradeId: bigint;
  entryVSol: number | null;
  exitVSol: number | null;
  pnlSol: number;
  pctOfSize: number;
  exitReason: string;
  holdSeconds: number;
  action: string | null;
  modulesAtEntry: Record<string, number> | null;
}): Promise<void> {
  try {
    await getDb().insert(tradeOutcomes).values({
      source: opts.source,
      tradeId: opts.tradeId,
      priceT0: opts.entryVSol,
      priceT1m: null,
      priceT5m: null,
      priceT30m: null,
      priceT1h: null,
      priceT6h: null,
      maxGainPct: null,
      maxDrawdownPct: null,
      graduatedWithin24h: null,
      extras: {
        win: opts.pnlSol > 0,
        pnl_sol: opts.pnlSol,
        pnl_pct: opts.pctOfSize,
        exit_reason: opts.exitReason,
        entry_action: opts.action,
        hold_seconds: opts.holdSeconds,
        modules: opts.modulesAtEntry,
        exit_v_sol: opts.exitVSol,
      },
    });
  } catch (e) {
    const msg = String(e);
    if (/duplicate|unique/i.test(msg)) return;
    log.warn("recordOutcome failed", { err: msg, tradeId: opts.tradeId.toString() });
  }
}

export async function attributeOutcomes(trades: UnattributedTrade[]): Promise<number> {
  if (trades.length === 0) return 0;
  const rows = trades.map((t) => {
    const pnl = t.pnlSol ?? 0;
    const win = pnl > 0;
    const pctOfSize = t.sizeSol > 0 ? pnl / t.sizeSol : 0;
    return {
      source: "paper" as const,
      tradeId: t.tradeId,
      priceT0: t.entryPrice,
      priceT1m: null,
      priceT5m: null,
      priceT30m: null,
      priceT1h: null,
      priceT6h: null,
      maxGainPct: null,
      maxDrawdownPct: null,
      graduatedWithin24h: null,
      extras: {
        win,
        pnl_sol: pnl,
        pnl_pct: pctOfSize,
        exit_reason: t.exitReason,
        entry_action: t.entryAction,
        entry_confluence: t.entryConfluence,
        modules: t.modulesAtEntry,
        mint: t.mint,
      },
    };
  });
  try {
    await getDb().insert(tradeOutcomes).values(rows);
    return rows.length;
  } catch (e) {
    log.warn("attribute insert failed", { err: String(e), n: rows.length });
    return 0;
  }
}

export type ActionPerf = {
  action: string;
  n: number;
  wins: number;
  losses: number;
  winRate: number | null;
  avgPnlPct: number | null;
  avgPnlSol: number | null;
  totalPnlSol: number;
};

export async function fetchActionPerformance(windowHours = 24): Promise<ActionPerf[]> {
  const res = await getDb().execute(sql`
    SELECT
      COALESCE(extras->>'entry_action', 'UNKNOWN') AS action,
      count(*)::int AS n,
      count(*) FILTER (WHERE (extras->>'win')::boolean = true)::int AS wins,
      count(*) FILTER (WHERE (extras->>'win')::boolean = false)::int AS losses,
      AVG((extras->>'pnl_pct')::float8)::float8 AS avg_pnl_pct,
      AVG((extras->>'pnl_sol')::float8)::float8 AS avg_pnl_sol,
      SUM((extras->>'pnl_sol')::float8)::float8 AS total_pnl_sol
    FROM trade_outcomes
    WHERE source = 'paper'
      AND recorded_at > now() - (${sql.raw(String(windowHours))} || ' hours')::interval
    GROUP BY action
    ORDER BY n DESC
  `);
  type Raw = {
    action: string;
    n: number;
    wins: number;
    losses: number;
    avg_pnl_pct: number | null;
    avg_pnl_sol: number | null;
    total_pnl_sol: number | null;
  };
  const rows = (res as unknown as { rows: Raw[] }).rows;
  return rows.map((r) => ({
    action: r.action,
    n: r.n,
    wins: r.wins,
    losses: r.losses,
    winRate: r.n > 0 ? r.wins / r.n : null,
    avgPnlPct: r.avg_pnl_pct,
    avgPnlSol: r.avg_pnl_sol,
    totalPnlSol: r.total_pnl_sol ?? 0,
  }));
}

export type ModuleBucketPerf = {
  module: string;
  bucket: string;
  bucketMin: number;
  bucketMax: number;
  n: number;
  wins: number;
  winRate: number | null;
  avgPnlPct: number | null;
};

export async function fetchModuleBucketPerformance(
  windowHours = 24,
): Promise<ModuleBucketPerf[]> {
  const res = await getDb().execute(sql`
    WITH base AS (
      SELECT
        (extras->'modules'->>'M1_GRADUATION')::float8 AS m1,
        (extras->'modules'->>'M3_RUG')::float8 AS m3,
        (extras->>'win')::boolean AS won,
        (extras->>'pnl_pct')::float8 AS pnl_pct
      FROM trade_outcomes
      WHERE source = 'paper'
        AND recorded_at > now() - (${sql.raw(String(windowHours))} || ' hours')::interval
    ),
    m1_b AS (
      SELECT 'M1_GRADUATION' AS module,
        CASE
          WHEN m1 < 0.5 THEN '0.00-0.50'
          WHEN m1 < 0.6 THEN '0.50-0.60'
          WHEN m1 < 0.7 THEN '0.60-0.70'
          WHEN m1 < 0.8 THEN '0.70-0.80'
          ELSE '0.80-1.00'
        END AS bucket,
        CASE
          WHEN m1 < 0.5 THEN 0.0
          WHEN m1 < 0.6 THEN 0.5
          WHEN m1 < 0.7 THEN 0.6
          WHEN m1 < 0.8 THEN 0.7
          ELSE 0.8
        END AS b_min,
        CASE
          WHEN m1 < 0.5 THEN 0.5
          WHEN m1 < 0.6 THEN 0.6
          WHEN m1 < 0.7 THEN 0.7
          WHEN m1 < 0.8 THEN 0.8
          ELSE 1.0
        END AS b_max,
        won, pnl_pct
      FROM base WHERE m1 IS NOT NULL
    ),
    m3_b AS (
      SELECT 'M3_RUG' AS module,
        CASE
          WHEN m3 < 0.1 THEN '0.00-0.10'
          WHEN m3 < 0.25 THEN '0.10-0.25'
          WHEN m3 < 0.5 THEN '0.25-0.50'
          ELSE '0.50-1.00'
        END AS bucket,
        CASE
          WHEN m3 < 0.1 THEN 0.0
          WHEN m3 < 0.25 THEN 0.1
          WHEN m3 < 0.5 THEN 0.25
          ELSE 0.5
        END AS b_min,
        CASE
          WHEN m3 < 0.1 THEN 0.1
          WHEN m3 < 0.25 THEN 0.25
          WHEN m3 < 0.5 THEN 0.5
          ELSE 1.0
        END AS b_max,
        won, pnl_pct
      FROM base WHERE m3 IS NOT NULL
    ),
    combined AS (
      SELECT * FROM m1_b UNION ALL SELECT * FROM m3_b
    )
    SELECT
      module,
      bucket,
      b_min::float8 AS b_min,
      b_max::float8 AS b_max,
      count(*)::int AS n,
      count(*) FILTER (WHERE won)::int AS wins,
      AVG(pnl_pct)::float8 AS avg_pnl_pct
    FROM combined
    GROUP BY module, bucket, b_min, b_max
    ORDER BY module, b_min
  `);
  type Raw = {
    module: string;
    bucket: string;
    b_min: number;
    b_max: number;
    n: number;
    wins: number;
    avg_pnl_pct: number | null;
  };
  const rows = (res as unknown as { rows: Raw[] }).rows;
  return rows.map((r) => ({
    module: r.module,
    bucket: r.bucket,
    bucketMin: r.b_min,
    bucketMax: r.b_max,
    n: r.n,
    wins: r.wins,
    winRate: r.n > 0 ? r.wins / r.n : null,
    avgPnlPct: r.avg_pnl_pct,
  }));
}

export type ExitReasonPerf = {
  reason: string;
  n: number;
  totalPnlSol: number;
  avgPnlSol: number | null;
};

export async function fetchExitReasonPerformance(windowHours = 24): Promise<ExitReasonPerf[]> {
  const res = await getDb().execute(sql`
    SELECT
      COALESCE(extras->>'exit_reason', 'unknown') AS reason,
      count(*)::int AS n,
      SUM((extras->>'pnl_sol')::float8)::float8 AS total_pnl,
      AVG((extras->>'pnl_sol')::float8)::float8 AS avg_pnl
    FROM trade_outcomes
    WHERE source = 'paper'
      AND recorded_at > now() - (${sql.raw(String(windowHours))} || ' hours')::interval
    GROUP BY reason
    ORDER BY n DESC
  `);
  type Raw = { reason: string; n: number; total_pnl: number | null; avg_pnl: number | null };
  const rows = (res as unknown as { rows: Raw[] }).rows;
  return rows.map((r) => ({
    reason: r.reason,
    n: r.n,
    totalPnlSol: r.total_pnl ?? 0,
    avgPnlSol: r.avg_pnl,
  }));
}
