import "server-only";
import { eq, sql, desc, inArray } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { decisionLog } from "@/lib/db/schema";
import { logger } from "@/lib/log";
import { demoWalletTradeSql } from "@/lib/db/repos/trading-mode";
import { PAPER_TRADES_READ } from "@/lib/db/paper-read";
import { paperOpen, paperClose } from "@/lib/paper/engine";

const log = logger("repo:paper");

export type OpenPaperRow = {
  id: bigint;
  mint: string;
  sizeSol: number;
  entryVSol: number | null;
  openedAt: Date;
  modulesAtEntry: Record<string, number> | null;
  action: string | null;
};

export async function fetchOpenPositions(): Promise<OpenPaperRow[]> {
  const res = await getDb().execute(sql`
    SELECT id, mint::text AS mint, size_sol::float8 AS size_sol,
           entry_v_sol::float8 AS entry_v_sol, opened_at, modules_at_entry, entry_features
    FROM ${sql.raw(PAPER_TRADES_READ)}
    WHERE status = 'open'
  `);
  type Raw = {
    id: bigint | string;
    mint: string;
    size_sol: number;
    entry_v_sol: number | null;
    opened_at: Date | string;
    modules_at_entry: Record<string, number> | null;
    entry_features: { action?: string } | null;
  };
  return (res as unknown as { rows: Raw[] }).rows.map((r) => ({
    id: typeof r.id === "bigint" ? r.id : BigInt(r.id),
    mint: r.mint,
    sizeSol: r.size_sol,
    entryVSol: r.entry_v_sol,
    openedAt: r.opened_at instanceof Date ? r.opened_at : new Date(r.opened_at),
    modulesAtEntry: r.modules_at_entry,
    action: r.entry_features?.action ?? null,
  }));
}

export async function fetchOpenMints(): Promise<Set<string>> {
  const res = await getDb().execute(sql`
    SELECT mint::text AS mint
    FROM ${sql.raw(PAPER_TRADES_READ)}
    WHERE status = 'open'
  `);
  return new Set(
    (res as unknown as { rows: Array<{ mint: string }> }).rows.map((r) => r.mint),
  );
}

/** Open paper mints for a specific auto-trade session only. */
export async function fetchOpenMintsForSession(sessionId: string): Promise<Set<string>> {
  const res = await getDb().execute(sql`
    SELECT mint::text AS mint
    FROM ${sql.raw(PAPER_TRADES_READ)}
    WHERE status = 'open'
      AND entry_features->>'session_id' = ${sessionId}
      AND COALESCE(entry_features->>'auto', 'true') = 'true'
      AND entry_features->>'shadow_of' IS NULL
  `);
  return new Set(
    (res as unknown as { rows: Array<{ mint: string }> }).rows.map((r) => r.mint),
  );
}

export async function openPaperPosition(opts: {
  mint: string;
  sizeSol: number;
  entryVSol: number;
  action: string;
  modulesAtEntry: Record<string, number>;
  decisionId: bigint;
  entryFeaturesExtra?: Record<string, unknown>;
}): Promise<bigint | null> {
  return openPaperTradeFlexible({
    ...opts,
    decisionId: opts.decisionId,
    markDecisionExecuted: true,
  });
}

export async function openPaperTradeFlexible(opts: {
  mint: string;
  sizeSol: number;
  entryVSol: number;
  action: string;
  modulesAtEntry: Record<string, number>;
  decisionId?: bigint | null;
  markDecisionExecuted?: boolean;
  entryFeaturesExtra?: Record<string, unknown>;
}): Promise<bigint | null> {
  try {
    const entryFeatures = {
      entry_v_sol: opts.entryVSol,
      action: opts.action,
      ...(opts.decisionId != null ? { decision_id: opts.decisionId.toString() } : {}),
      ...(opts.entryFeaturesExtra ?? {}),
    };
    const opened = await paperOpen({
      mint: opts.mint,
      sizeSol: opts.sizeSol,
      entryFeatures,
      modulesAtEntry: opts.modulesAtEntry,
      decisionId: opts.decisionId ?? null,
    });
    if (!opened.ok) return null;
    const id = opened.data.positionId;
    if (opts.markDecisionExecuted && opts.decisionId != null) {
      await getDb()
        .update(decisionLog)
        .set({
          executed: "executed_paper",
          executorReason: `paper_trade=${id.toString()}`,
        })
        .where(eq(decisionLog.id, opts.decisionId));
    }
    return id;
  } catch (e) {
    log.warn("open paper failed", { mint: opts.mint, err: String(e) });
    return null;
  }
}

export async function fetchOpenDemoByMint(mint: string): Promise<OpenPaperRow | null> {
  const res = await getDb().execute(sql`
    SELECT id, mint, size_sol::float8 AS size_sol, entry_v_sol::float8 AS entry_v_sol,
           opened_at, modules_at_entry, entry_features
    FROM ${sql.raw(PAPER_TRADES_READ)}
    WHERE status = 'open' AND mint = ${mint}
      AND ${demoWalletTradeSql}
    LIMIT 1
  `);
  type Raw = {
    id: bigint | string;
    mint: string;
    size_sol: number;
    entry_v_sol: number | null;
    opened_at: Date | string;
    modules_at_entry: Record<string, number> | null;
    entry_features: { action?: string } | null;
  };
  const r = (res as unknown as { rows: Raw[] }).rows[0];
  if (!r) return null;
  return {
    id: typeof r.id === "bigint" ? r.id : BigInt(r.id),
    mint: r.mint,
    sizeSol: r.size_sol,
    entryVSol: r.entry_v_sol,
    openedAt: r.opened_at instanceof Date ? r.opened_at : new Date(r.opened_at),
    modulesAtEntry: r.modules_at_entry,
    action: r.entry_features?.action ?? null,
  };
}

export async function closePaperPosition(opts: {
  id: bigint;
  exitVSol: number;
  pnlSol: number;
  feesSol: number;
  reason: string;
}): Promise<void> {
  void opts.exitVSol;
  void opts.pnlSol;
  void opts.feesSol;
  const closed = await paperClose({ positionId: opts.id, reason: opts.reason });
  if (!closed.ok) {
    log.warn("close paper failed", { id: opts.id.toString(), reason: closed.reason });
  }
}

export async function markDecisionsSkipped(
  decisionIds: bigint[],
  reason: string,
): Promise<void> {
  if (decisionIds.length === 0) return;
  await getDb()
    .update(decisionLog)
    .set({ executed: "skipped", executorReason: reason.slice(0, 120) })
    .where(inArray(decisionLog.id, decisionIds));
}

export type PendingBuyDecisionDto = {
  id: bigint;
  mint: string;
  action: string;
  confluenceScore: number;
  moduleScores: Record<string, number>;
  ts: string;
};

export type AutoTradeQueueOpts = {
  /** Include intelligence buys gated off strict auto_trade_allowed (demo/paper relax). */
  relaxAutoGate?: boolean;
};

/** Inline WHERE (raw text — no nested sql fragments — keeps parameter typing predictable). */
function autoTradeBuyQueueWhereSql(maxAgeSeconds: number, relaxAutoGate: boolean): string {
  const sec = Math.max(1, Math.floor(maxAgeSeconds));
  const age = `ts > now() - interval '${sec} seconds'`;
  if (!relaxAutoGate) {
    return `action IN ('BUY_STRONG', 'BUY_MODERATE')
      AND executed = 'pending'
      AND COALESCE((module_scores->>'_auto_trade_allowed')::float8, 0) >= 1
      AND ${age}`;
  }
  return `action IN ('BUY_STRONG', 'BUY_MODERATE')
      AND ${age}
      AND (
        (executed = 'pending' AND COALESCE((module_scores->>'_auto_trade_allowed')::float8, 0) >= 1)
        OR (executed = 'skipped' AND executor_reason = 'auto_trade_blocked')
      )`;
}

export async function fetchPendingBuyDecisions(
  maxAgeSeconds = 90,
  opts?: AutoTradeQueueOpts,
): Promise<PendingBuyDecisionDto[]> {
  const relax = opts?.relaxAutoGate ?? false;
  const where = autoTradeBuyQueueWhereSql(maxAgeSeconds, relax);
  const res = await getDb().execute(
    sql.raw(`
    SELECT id, mint, action, ts, confluence_score::float8 AS confluence_score, module_scores
    FROM decision_log
    WHERE ${where}
    ORDER BY COALESCE((module_scores->>'_engine_a')::int, 0) DESC, confluence_score DESC, ts DESC
    LIMIT 50
  `),
  );
  type Raw = {
    id: bigint | string | number;
    mint: string;
    action: string;
    ts: Date | string;
    confluence_score: number;
    module_scores: Record<string, number> | null;
  };
  const rows = (res as unknown as { rows: Raw[] }).rows;
  return rows.map((r) => ({
    id: typeof r.id === "bigint" ? r.id : BigInt(r.id),
    mint: r.mint,
    action: r.action,
    ts: r.ts instanceof Date ? r.ts.toISOString() : String(r.ts),
    confluenceScore: r.confluence_score,
    moduleScores: r.module_scores ?? {},
  }));
}

function autoTradeGateSql(relaxAutoGate: boolean): string {
  if (!relaxAutoGate) {
    return `d.executed = 'pending'
        AND COALESCE((d.module_scores->>'_auto_trade_allowed')::float8, 0) >= 1`;
  }
  return `(
        (d.executed = 'pending' AND COALESCE((d.module_scores->>'_auto_trade_allowed')::float8, 0) >= 1)
        OR (d.executed = 'skipped' AND d.executor_reason = 'auto_trade_blocked')
      )`;
}

/** Tradable BUY signals still pending — used when the short pending queue is empty. */
export async function fetchTradableAutoFallback(
  limit = 8,
  opts?: AutoTradeQueueOpts,
): Promise<PendingBuyDecisionDto[]> {
  const relax = opts?.relaxAutoGate ?? false;
  const gate = autoTradeGateSql(relax);
  const lim = Math.min(20, Math.max(1, limit));
  const res = await getDb().execute(
    sql.raw(`
    SELECT d.id, d.mint, d.action, d.ts, d.confluence_score::float8 AS confluence_score, d.module_scores
    FROM decision_log d
    WHERE d.action IN ('BUY_STRONG', 'BUY_MODERATE')
      AND ${gate}
      AND d.ts > now() - interval '5 minutes'
    ORDER BY COALESCE((d.module_scores->>'_engine_a')::int, 0) DESC, d.confluence_score DESC, d.ts DESC
    LIMIT ${lim}
  `),
  );
  type Raw = {
    id: bigint | string | number;
    mint: string;
    action: string;
    ts: Date | string;
    confluence_score: number;
    module_scores: Record<string, number> | null;
  };
  const rows = (res as unknown as { rows: Raw[] }).rows;
  return rows.map((r) => ({
    id: typeof r.id === "bigint" ? r.id : BigInt(r.id),
    mint: r.mint,
    action: r.action,
    ts: r.ts instanceof Date ? r.ts.toISOString() : String(r.ts),
    confluenceScore: r.confluence_score,
    moduleScores: r.module_scores ?? {},
  }));
}

export async function countPendingBuyDecisions(
  maxAgeSeconds = 90,
  opts?: AutoTradeQueueOpts,
): Promise<number> {
  const relax = opts?.relaxAutoGate ?? false;
  const where = autoTradeBuyQueueWhereSql(maxAgeSeconds, relax);
  const res = await getDb().execute(
    sql.raw(`
    SELECT COUNT(*)::int AS n
    FROM decision_log
    WHERE ${where}
  `),
  );
  return ((res as unknown as { rows: Array<{ n: number }> }).rows[0]?.n) ?? 0;
}

export type PositionDto = {
  id: string;
  status: "open" | "closed";
  mint: string;
  symbol: string | null;
  name: string | null;
  sizeSol: number;
  entryVSol: number | null;
  exitVSol: number | null;
  pnlSol: number | null;
  pctOfSize: number | null;
  ageSeconds: number;
  exitReason: string | null;
  openedAt: string;
  closedAt: string | null;
  modulesAtEntry: Record<string, number> | null;
  action: string | null;
};

export async function fetchRecentPositions(limit = 30): Promise<PositionDto[]> {
  const res = await getDb().execute(sql`
    SELECT
      p.id::text AS id,
      p.status::text AS status,
      p.mint::text AS mint,
      p.size_sol::float8 AS size_sol,
      p.entry_v_sol::float8 AS entry_v_sol,
      p.exit_v_sol::float8 AS exit_v_sol,
      p.pnl_sol::float8 AS pnl_sol,
      p.exit_reason::text AS exit_reason,
      p.opened_at AS opened_at,
      p.closed_at AS closed_at,
      p.modules_at_entry AS modules_at_entry,
      p.entry_features->>'action' AS action,
      t.symbol::text AS symbol,
      t.name::text AS name,
      EXTRACT(EPOCH FROM (COALESCE(p.closed_at, now()) - p.opened_at))::float8 AS age_seconds
    FROM ${sql.raw(PAPER_TRADES_READ)} p
    LEFT JOIN tokens t ON t.mint = p.mint
    ORDER BY (p.status = 'open') DESC, p.opened_at DESC
    LIMIT ${sql.raw(String(limit))}
  `);
  type Raw = {
    id: string;
    status: string;
    mint: string;
    size_sol: number;
    entry_v_sol: number | null;
    exit_v_sol: number | null;
    pnl_sol: number | null;
    exit_reason: string | null;
    opened_at: Date | string;
    closed_at: Date | string | null;
    modules_at_entry: Record<string, number> | null;
    action: string | null;
    symbol: string | null;
    name: string | null;
    age_seconds: number;
  };
  const rows = (res as unknown as { rows: Raw[] }).rows;
  return rows.map((r) => {
    const pct =
      r.pnl_sol != null && r.size_sol > 0 ? r.pnl_sol / r.size_sol : null;
    return {
      id: r.id,
      status: (r.status === "open" ? "open" : "closed") as "open" | "closed",
      mint: r.mint,
      symbol: r.symbol,
      name: r.name,
      sizeSol: r.size_sol,
      entryVSol: r.entry_v_sol,
      exitVSol: r.exit_v_sol,
      pnlSol: r.pnl_sol,
      pctOfSize: pct,
      ageSeconds: r.age_seconds,
      exitReason: r.exit_reason,
      openedAt: r.opened_at instanceof Date ? r.opened_at.toISOString() : String(r.opened_at),
      closedAt:
        r.closed_at == null
          ? null
          : r.closed_at instanceof Date
            ? r.closed_at.toISOString()
            : String(r.closed_at),
      modulesAtEntry: r.modules_at_entry,
      action: r.action,
    };
  });
}

export type PaperStatsDto = {
  startSol: number;
  realizedPnlSol: number;
  unrealizedPnlSol: number;
  openCount: number;
  closedCount: number;
  wins: number;
  losses: number;
  winRate: number | null;
  bestPnl: number | null;
  worstPnl: number | null;
};

export async function fetchClosedAggregates(): Promise<{
  realized: number;
  closed: number;
  wins: number;
  losses: number;
  best: number | null;
  worst: number | null;
}> {
  const res = await getDb().execute(sql`
    SELECT
      COALESCE(SUM(pnl_sol), 0)::float8 AS realized,
      COUNT(*)::int AS closed,
      COUNT(*) FILTER (WHERE pnl_sol > 0)::int AS wins,
      COUNT(*) FILTER (WHERE pnl_sol <= 0)::int AS losses,
      MAX(pnl_sol)::float8 AS best,
      MIN(pnl_sol)::float8 AS worst
    FROM ${sql.raw(PAPER_TRADES_READ)}
    WHERE status = 'closed'
  `);
  type Raw = {
    realized: number;
    closed: number;
    wins: number;
    losses: number;
    best: number | null;
    worst: number | null;
  };
  const row = (res as unknown as { rows: Raw[] }).rows[0];
  return (
    row ?? { realized: 0, closed: 0, wins: 0, losses: 0, best: null, worst: null }
  );
}
