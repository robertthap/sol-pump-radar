import "server-only";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { liveTrades } from "@/lib/db/schema";
import { logger } from "@/lib/log";

const log = logger("repo:live");

export type LiveTradeRoute = "pumpportal" | "jupiter" | "blocked";

export type OpenLiveOpts = {
  mint: string;
  sizeSol: number;
  entryPrice?: number | null;
  modulesAtEntry?: Record<string, number> | null;
  entryFeatures?: Record<string, unknown> | null;
  txSignatureOpen?: string | null;
  dryRun: boolean;
  route: LiveTradeRoute;
  status: "pending" | "open" | "failed";
  errorMessage?: string | null;
  feesSol?: number;
  slippageBps?: number | null;
  sessionId?: string | null;
};

export async function openLivePosition(opts: OpenLiveOpts): Promise<bigint> {
  const [inserted] = await getDb()
    .insert(liveTrades)
    .values({
      mint: opts.mint,
      side: "buy",
      status: opts.status,
      sizeSol: opts.sizeSol,
      entryPrice: opts.entryPrice ?? null,
      feesSol: opts.feesSol ?? 0,
      slippageBps: opts.slippageBps ?? null,
      modulesAtEntry: opts.modulesAtEntry ?? null,
      entryFeatures: opts.entryFeatures ?? null,
      txSignatureOpen: opts.txSignatureOpen ?? null,
      buySignature: opts.txSignatureOpen ?? null,
      dryRun: opts.dryRun,
      route: opts.route,
      errorMessage: opts.errorMessage ?? null,
      network: "mainnet",
      sessionId: opts.sessionId ?? null,
    })
    .returning({ id: liveTrades.id });
  if (!inserted) throw new Error("failed to insert live trade");
  return inserted.id;
}

export type CloseLiveOpts = {
  id: bigint;
  exitPrice?: number | null;
  pnlSol?: number | null;
  feesSol?: number;
  exitReason?: string | null;
  txSignatureClose?: string | null;
  errorMessage?: string | null;
  status?: "closed" | "failed" | "close_failed";
};

export async function closeLivePosition(opts: CloseLiveOpts): Promise<void> {
  await getDb()
    .update(liveTrades)
    .set({
      status: opts.status ?? "closed",
      exitPrice: opts.exitPrice ?? null,
      pnlSol: opts.pnlSol ?? null,
      feesSol: opts.feesSol ?? 0,
      exitReason: opts.exitReason ?? null,
      txSignatureClose: opts.txSignatureClose ?? null,
      sellSignature: opts.txSignatureClose ?? null,
      errorMessage: opts.errorMessage ?? null,
      closedAt: new Date(),
    })
    .where(eq(liveTrades.id, opts.id));
}

export async function fetchOpenLivePositions() {
  return await getDb()
    .select()
    .from(liveTrades)
    .where(and(eq(liveTrades.status, "open"), isNull(liveTrades.closedAt)));
}

export async function fetchOpenLiveByMint(mint: string) {
  return await getDb()
    .select()
    .from(liveTrades)
    .where(
      and(
        or(eq(liveTrades.status, "open"), eq(liveTrades.status, "pending_close")),
        eq(liveTrades.mint, mint),
        isNull(liveTrades.closedAt),
      ),
    )
    .limit(1);
}

/** Atomically claim open rows for sell-all before queuing intents. */
export async function markLivePositionsPendingClose(ids: bigint[]): Promise<number> {
  if (ids.length === 0) return 0;
  const res = await getDb().execute(sql`
    UPDATE live_trades
    SET status = 'pending_close'
    WHERE id = ANY(${ids}::bigint[])
      AND status = 'open'
      AND closed_at IS NULL
  `);
  return (res as unknown as { rowCount?: number }).rowCount ?? ids.length;
}

export async function markLivePositionCloseFailed(id: bigint, reason: string): Promise<void> {
  await getDb()
    .update(liveTrades)
    .set({
      status: "close_failed",
      errorMessage: reason.slice(0, 500),
    })
    .where(eq(liveTrades.id, id));
}

export async function fetchLivePositionsNeedingAttention(limit = 50) {
  return await getDb()
    .select()
    .from(liveTrades)
    .where(inArray(liveTrades.status, ["close_failed", "pending_close"]))
    .orderBy(desc(liveTrades.openedAt))
    .limit(limit);
}

export type LiveHoldingsDto = {
  id: string;
  mint: string;
  sizeSol: number;
  entryPrice: number | null;
  route: string | null;
  status: string;
  dryRun: boolean;
  txOpen: string | null;
  openedAt: Date;
  modulesAtEntry: Record<string, number> | null;
  entryFeatures: Record<string, unknown> | null;
};

/** Open + in-flight exit rows for /api/holdings reconciliation. */
export async function fetchLiveHoldingsTrades(limit = 200): Promise<LiveHoldingsDto[]> {
  const rows = await getDb()
    .select()
    .from(liveTrades)
    .where(inArray(liveTrades.status, ["open", "pending_close", "close_failed"]))
    .orderBy(desc(liveTrades.openedAt))
    .limit(Math.min(200, Math.max(1, limit)));
  return rows.map((t) => ({
    id: t.id.toString(),
    mint: t.mint,
    sizeSol: t.sizeSol,
    entryPrice: t.entryPrice,
    route: t.route,
    status: t.status,
    dryRun: t.dryRun,
    txOpen: t.txSignatureOpen ?? t.buySignature,
    openedAt: t.openedAt,
    modulesAtEntry: (t.modulesAtEntry as Record<string, number> | null) ?? null,
    entryFeatures: (t.entryFeatures as Record<string, unknown> | null) ?? null,
  }));
}

/** Sum of sizeSol for live_trades opened today (UTC) excluding failed. */
export async function fetchDailyLiveSol(): Promise<number> {
  const res = await getDb().execute(sql`
    SELECT COALESCE(SUM(size_sol), 0)::float8 AS total
    FROM live_trades
    WHERE status <> 'failed'
      AND opened_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
  `);
  const rows = (res as unknown as { rows: Array<{ total: number }> }).rows;
  return rows[0]?.total ?? 0;
}

export type LiveTradeRow = typeof liveTrades.$inferSelect;

export async function fetchRecentLiveTrades(limit = 50): Promise<LiveTradeRow[]> {
  return await getDb()
    .select()
    .from(liveTrades)
    .orderBy(desc(liveTrades.openedAt))
    .limit(limit);
}

export async function fetchRecentLiveByMint(mint: string, limit = 20): Promise<LiveTradeRow[]> {
  return await getDb()
    .select()
    .from(liveTrades)
    .where(eq(liveTrades.mint, mint))
    .orderBy(desc(liveTrades.openedAt))
    .limit(limit);
}

export function liveTradesLogger() {
  return log;
}
