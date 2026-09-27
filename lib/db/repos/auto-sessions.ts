import "server-only";
import { sql, desc, eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { PAPER_TRADES_READ } from "@/lib/db/paper-read";
import { autoSessions } from "@/lib/db/schema";
import { logger } from "@/lib/log";
import { notify } from "@/lib/notify";
import { autoSkipReasonLabel } from "@/lib/ui/plain-labels";

const log = logger("repo:auto");

export type AutoSessionParams = {
  sizeSol: number;
  takeProfitPct: number;
  stopLossPct: number;
  maxConcurrent: number;
  maxDailyLossSol: number;
  signalStrictness: "strong" | "strong_and_moderate";
  useLearnedAvoids: boolean;
  maxHoldMinutes: number;
  /**
   * Multi-tier exit ladder (Kalacheva et al. 2026 §6.3).
   * When `tp1Pct` is set, partial exit at +tp1Pct% sells `tp1Fraction` of
   * the position; the remainder rides until takeProfitPct, stop-loss, or
   * timeout. When unset, behaviour is the legacy single-TP exit.
   */
  tp1Pct?: number;
  tp1Fraction?: number;
  /**
   * Trailing stop (L4): once unrealized PnL reaches `trailingArmPct`, exit if it
   * falls `trailingStopPct` below the peak. Locks gains on the vicious reversals
   * typical of pump.fun. 0/undefined disables. Paper-first.
   */
  trailingArmPct?: number;
  trailingStopPct?: number;
  /**
   * Flat-position cut: close a position that never exceeded
   * `stagnationMaxPeakPct` by this age, freeing the slot for a fresh signal.
   * Historically this was hard-coded at 0.4 x maxHoldMinutes with the ceiling
   * pinned to `trailingArmPct`; both defaults preserve that exactly.
   */
  stagnationMinutes?: number;
  stagnationMaxPeakPct?: number;
  /**
   * Opt-in DEX order-flow entry gate (the "momentum" preset). Undefined leaves
   * only the always-on baseline, which rejects coins that are not trading or are
   * being dumped. Deliberately no price threshold: winners historically had
   * NEGATIVE 5m price change at entry, so chasing a pump buys the local top.
   */
  minDexBuysM5?: number;
  minDexBuySellRatio?: number;
  minDexVolAccel?: number;
  /**
   * Smart-money entry requirement (the "smartMoney" preset). "strong" needs a
   * watched wallet, or two profiled wallets with edge, buying the mint in the
   * last 5 minutes; "weak" also accepts a single profiled wallet. Undefined /
   * "off" leaves entry selection untouched and costs nothing — the signal is
   * only computed when a session actually asks for it.
   *
   * FAILS CLOSED BY OMISSION: `events` holds bonding-curve trades only, so a
   * watched wallet buying a graduated coin is invisible and reads as no signal.
   * Requiring "strong" therefore skips trades it should have taken; it never
   * takes one it should have skipped.
   */
  requireSmartMoney?: "off" | "weak" | "strong";
  /**
   * Curve-position entry band, in vSol. Derived from where better wallets
   * actually operate: the operator's watchlist buys in a tight 46-69 window
   * (median 54.5) while this bot's own entries median 150, i.e. mostly at or
   * past graduation. Undefined leaves entry unrestricted.
   */
  minEntryVSol?: number;
  maxEntryVSol?: number;
  /**
   * Fixed CASH take-profit, in USD, replacing takeProfitPct when set. Converted
   * per exit pass against the executor's real friction and the live SOL price;
   * a target needing more than +100% net is refused and takeProfitPct is used
   * instead. See lib/trade/profit-target.ts.
   */
  profitTargetUsd?: number;
  /**
   * CURVE LADDER replication gate (the "curveLadder" preset). Entry requires a
   * fresh bonding-curve rung crossing that satisfies all three of the source
   * specification's conditions.
   *
   * EXPECT APPROXIMATELY NO TRADES. Offline over 10,507 episodes on our own
   * 7-day feed the rule fired 29 times (0.28%), never below rung 30, and its
   * mean net return was negative at every cost setting. This exists so the
   * published negative result can be checked live, not because it is expected
   * to make money. See lib/trade/curve-ladder.ts.
   */
  requireCurveLadder?: boolean;
  /**
   * Relax this session's own opt-in momentum thresholds by half when the
   * smart-money signal is strong. Never relaxes the baseline dead/dumping veto
   * — see relaxMomentumThresholds.
   */
  smartMoneyBoost?: boolean;
};

export type AutoSessionStats = {
  tradesOpened: number;
  tradesClosed: number;
  wins: number;
  losses: number;
  realizedPnlSol: number;
  lastTickAt?: string | null;
  lastErrorMessage?: string | null;
  lastPendingCount?: number;
  lastOpenedCount?: number;
  lastSkipReasons?: string[];
  /** Transient entry-filter skips (retryable — not written to decision_log). */
  recentFilterSkips?: Array<{ ts: string; mint: string; reason: string }>;
};

export const DEFAULT_PARAMS: AutoSessionParams = {
  sizeSol: 0.03,
  takeProfitPct: 0.28,
  stopLossPct: 0.15,
  maxConcurrent: 5,
  // Paper measurement default: 1.0 SOL/day so a data-collection run isn't cut
  // short after ~50 trades. It's paper money; you want the sample size. Lower it
  // (or set per-session) once you go live. Restarting a session also resets the
  // per-session daily counter.
  maxDailyLossSol: 1.0,
  signalStrictness: "strong_and_moderate",
  useLearnedAvoids: false,
  maxHoldMinutes: 45,
  tp1Pct: 0.15,
  tp1Fraction: 0.5,
  // After +15% unrealized, trail 8% from peak (locks gains before reversal).
  trailingArmPct: 0.15,
  trailingStopPct: 0.08,
};

export const DEFAULT_STATS: AutoSessionStats = {
  tradesOpened: 0,
  tradesClosed: 0,
  wins: 0,
  losses: 0,
  realizedPnlSol: 0,
  lastTickAt: null,
  lastErrorMessage: null,
};

export type AutoSessionDto = {
  id: string;
  startedAt: string;
  stoppedAt: string | null;
  status: "active" | "stopped" | "error";
  mode: "paper" | "live";
  params: AutoSessionParams;
  stats: AutoSessionStats;
  stopReason: string | null;
};

function rowToDto(row: typeof autoSessions.$inferSelect): AutoSessionDto {
  return {
    id: row.id.toString(),
    startedAt: row.startedAt.toISOString(),
    stoppedAt: row.stoppedAt ? row.stoppedAt.toISOString() : null,
    status: (row.status as AutoSessionDto["status"]) ?? "stopped",
    mode: (row.mode as AutoSessionDto["mode"]) ?? "paper",
    params: { ...DEFAULT_PARAMS, ...((row.params as AutoSessionParams) ?? {}) },
    stats: { ...DEFAULT_STATS, ...((row.stats as AutoSessionStats) ?? {}) },
    stopReason: row.stopReason ?? null,
  };
}

export async function getActiveSession(): Promise<AutoSessionDto | null> {
  const rows = await getDb()
    .select()
    .from(autoSessions)
    .where(eq(autoSessions.status, "active"))
    .orderBy(desc(autoSessions.startedAt))
    .limit(1);
  return rows[0] ? rowToDto(rows[0]) : null;
}

export async function getLatestSession(): Promise<AutoSessionDto | null> {
  const rows = await getDb()
    .select()
    .from(autoSessions)
    .orderBy(desc(autoSessions.startedAt))
    .limit(1);
  return rows[0] ? rowToDto(rows[0]) : null;
}

export async function startSession(opts: {
  mode: "paper" | "live";
  params: AutoSessionParams;
}): Promise<AutoSessionDto> {
  // Stop any existing active session first.
  await getDb()
    .update(autoSessions)
    .set({ status: "stopped", stoppedAt: new Date(), stopReason: "superseded" })
    .where(eq(autoSessions.status, "active"));
  const [row] = await getDb()
    .insert(autoSessions)
    .values({
      mode: opts.mode,
      status: "active",
      params: opts.params,
      stats: { ...DEFAULT_STATS, lastTickAt: new Date().toISOString() },
    })
    .returning();
  log.info("auto session started", { id: row?.id?.toString(), mode: opts.mode });
  await notify({
    kind: "auto_started",
    title: `Auto-Trade started (${opts.mode === "live" ? "REAL MONEY" : "Practice"})`,
    body: `size=${opts.params.sizeSol} SOL · TP=${(opts.params.takeProfitPct * 100).toFixed(0)}% · SL=${(opts.params.stopLossPct * 100).toFixed(0)}% · max ${opts.params.maxConcurrent} concurrent · daily loss cap ${opts.params.maxDailyLossSol} SOL`,
    severity: opts.mode === "live" ? "warn" : "info",
  });
  return rowToDto(row!);
}

export async function stopSession(reason: string): Promise<void> {
  const r = await getDb()
    .update(autoSessions)
    .set({
      status: "stopped",
      stoppedAt: new Date(),
      stopReason: reason.slice(0, 120),
    })
    .where(eq(autoSessions.status, "active"))
    .returning({ id: autoSessions.id });
  if (r.length > 0) {
    log.info("auto session stopped", { id: r[0]!.id.toString(), reason });
    await notify({
      kind: "auto_stopped",
      title: "Auto-Trade stopped",
      body: reason,
      severity: reason.includes("daily loss") ? "warn" : "info",
    });
  }
}

export async function markSessionError(reason: string): Promise<void> {
  await getDb()
    .update(autoSessions)
    .set({
      status: "error",
      stoppedAt: new Date(),
      stopReason: reason.slice(0, 120),
    })
    .where(eq(autoSessions.status, "active"));
  log.warn("auto session marked error", { reason });
  await notify({
    kind: "auto_error",
    title: "Auto-Trade error — stopped",
    body: reason,
    severity: "error",
  });
}

export async function updateStats(id: bigint, stats: Partial<AutoSessionStats>): Promise<void> {
  // Merge with existing stats by reading-then-writing.
  const cur = await getDb()
    .select({ stats: autoSessions.stats })
    .from(autoSessions)
    .where(eq(autoSessions.id, id))
    .limit(1);
  const merged = { ...DEFAULT_STATS, ...(cur[0]?.stats as AutoSessionStats), ...stats };
  await getDb().update(autoSessions).set({ stats: merged }).where(eq(autoSessions.id, id));
}

export type SessionCounter = "tradesOpened" | "tradesClosed" | "wins" | "losses" | "realizedPnlSol";

/** Add `delta` to one numeric session stat in place (single statement, no read-modify-write race). */
export async function accumulateSessionStat(sessionId: string, key: SessionCounter, delta: number): Promise<void> {
  if (!Number.isFinite(delta)) return;
  const k = key.replace(/'/g, "''");
  const sid = BigInt(sessionId).toString();
  await getDb().execute(
    sql.raw(`
    UPDATE auto_sessions
    SET stats = jsonb_set(
      stats,
      '{${k}}',
      to_jsonb(COALESCE((stats->>'${k}')::float8, 0) + ${delta})
    )
    WHERE id = ${sid}
  `),
  );
}

export async function fetchTodayLoss(sessionId: string): Promise<number> {
  const res = await getDb().execute(sql`
    SELECT COALESCE(SUM(pnl_sol), 0)::float8 AS loss
    FROM live_trades
    WHERE session_id = ${sessionId}
      AND status = 'closed'
      AND closed_at::date = now()::date
      AND pnl_sol < 0
  `);
  type Raw = { loss: number };
  const row = (res as unknown as { rows: Raw[] }).rows[0];
  return row?.loss ?? 0;
}

export async function fetchSessionTrades(sessionId: string, limit = 50) {
  const res = await getDb().execute(sql`
    (
      SELECT id::text AS id, mint, 'paper'::text AS source, status, size_sol::float8 AS size_sol,
        entry_v_sol::float8 AS entry_price, exit_v_sol::float8 AS exit_price,
        pnl_sol::float8 AS pnl_sol, exit_reason, false AS dry_run,
        to_char(opened_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS opened_at,
        to_char(closed_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS closed_at
      FROM ${sql.raw(PAPER_TRADES_READ)}
      WHERE entry_features->>'session_id' = ${sessionId}
        AND COALESCE(entry_features->>'auto', 'true') = 'true'
        AND entry_features->>'shadow_of' IS NULL
    )
    UNION ALL
    (
      SELECT id::text, mint, 'live'::text, status, size_sol::float8,
        entry_price::float8, exit_price::float8,
        pnl_sol::float8, exit_reason, dry_run,
        to_char(opened_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        to_char(closed_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      FROM live_trades
      WHERE session_id = ${sessionId}
    )
    ORDER BY opened_at DESC NULLS LAST
    LIMIT ${sql.raw(String(limit))}
  `);
  type Raw = {
    id: string;
    mint: string;
    source: "paper" | "live";
    status: string;
    size_sol: number;
    entry_price: number | null;
    exit_price: number | null;
    pnl_sol: number | null;
    exit_reason: string | null;
    dry_run: boolean;
    opened_at: string;
    closed_at: string | null;
  };
  return (res as unknown as { rows: Raw[] }).rows;
}

export type AutoTradeLogEntry = {
  id: string;
  ts: string;
  kind: "open" | "close" | "skip" | "tp1";
  mint: string | null;
  symbol: string | null;
  message: string;
  pnlSol: number | null;
  source: "paper" | "live" | "system";
};

/** Chronological auto-trade activity for live log panel. */
export async function fetchSessionActivityLog(
  sessionId: string,
  opts?: { since?: string; limit?: number },
): Promise<AutoTradeLogEntry[]> {
  const limit = Math.min(120, Math.max(15, opts?.limit ?? 40));
  const sinceRaw = opts?.since?.trim() || "";
  const sinceAt = sinceRaw ? new Date(sinceRaw) : null;
  const sinceEpoch =
    sinceAt != null && Number.isFinite(sinceAt.getTime()) ? sinceAt.getTime() / 1000 : 0;

  const res = await getDb().execute(sql`
    WITH sess AS (
      SELECT started_at FROM auto_sessions WHERE id = ${BigInt(sessionId)} LIMIT 1
    ),
    opens AS (
      SELECT
        ('p-open-' || p.id::text) AS id,
        p.opened_at AS ts,
        'open'::text AS kind,
        p.mint::text AS mint,
        t.symbol::text AS symbol,
        ('Opened ' || p.size_sol::text || ' SOL @ v=' || COALESCE(p.entry_v_sol::text, '?')) AS message,
        NULL::float8 AS pnl_sol,
        'paper'::text AS source
      FROM ${sql.raw(PAPER_TRADES_READ)} p
      LEFT JOIN tokens t ON t.mint = p.mint
      WHERE p.entry_features->>'session_id' = ${sessionId}
        AND COALESCE(p.entry_features->>'auto', 'true') = 'true'
        AND p.entry_features->>'shadow_of' IS NULL
        AND (${sinceEpoch}::float8 <= 0 OR EXTRACT(EPOCH FROM p.opened_at) > ${sinceEpoch}::float8)
    ),
    closes AS (
      SELECT
        ('p-close-' || p.id::text) AS id,
        p.closed_at AS ts,
        'close'::text AS kind,
        p.mint::text AS mint,
        t.symbol::text AS symbol,
        ('Closed ' || COALESCE(p.exit_reason, 'exit') || ' · PnL ' || COALESCE(p.pnl_sol::text, '0')) AS message,
        p.pnl_sol::float8 AS pnl_sol,
        'paper'::text AS source
      FROM ${sql.raw(PAPER_TRADES_READ)} p
      LEFT JOIN tokens t ON t.mint = p.mint
      WHERE p.entry_features->>'session_id' = ${sessionId}
        AND p.status = 'closed'
        AND p.entry_features->>'shadow_of' IS NULL
        AND p.closed_at IS NOT NULL
        AND (${sinceEpoch}::float8 <= 0 OR EXTRACT(EPOCH FROM p.closed_at) > ${sinceEpoch}::float8)
    ),
    live_opens AS (
      SELECT
        ('l-open-' || l.id::text) AS id,
        l.opened_at AS ts,
        'open'::text AS kind,
        l.mint::text AS mint,
        t.symbol::text AS symbol,
        ('Opened ' || l.size_sol::text || ' SOL' || CASE WHEN l.dry_run THEN ' (dry-run)' ELSE '' END) AS message,
        NULL::float8 AS pnl_sol,
        'live'::text AS source
      FROM live_trades l
      LEFT JOIN tokens t ON t.mint = l.mint
      WHERE l.session_id = ${sessionId}
        AND (${sinceEpoch}::float8 <= 0 OR EXTRACT(EPOCH FROM l.opened_at) > ${sinceEpoch}::float8)
    ),
    live_closes AS (
      SELECT
        ('l-close-' || l.id::text) AS id,
        l.closed_at AS ts,
        'close'::text AS kind,
        l.mint::text AS mint,
        t.symbol::text AS symbol,
        ('Closed ' || COALESCE(l.exit_reason, 'exit') || ' · PnL ' || COALESCE(l.pnl_sol::text, '0')) AS message,
        l.pnl_sol::float8 AS pnl_sol,
        'live'::text AS source
      FROM live_trades l
      LEFT JOIN tokens t ON t.mint = l.mint
      WHERE l.session_id = ${sessionId}
        AND l.status = 'closed'
        AND l.closed_at IS NOT NULL
        AND (${sinceEpoch}::float8 <= 0 OR EXTRACT(EPOCH FROM l.closed_at) > ${sinceEpoch}::float8)
    ),
    skips AS (
      SELECT
        ('skip-' || d.id::text) AS id,
        d.ts AS ts,
        'skip'::text AS kind,
        d.mint::text AS mint,
        t.symbol::text AS symbol,
        COALESCE(d.executor_reason, 'skipped') AS message,
        NULL::float8 AS pnl_sol,
        'system'::text AS source
      FROM decision_log d
      LEFT JOIN tokens t ON t.mint = d.mint
      CROSS JOIN sess
      WHERE d.executed = 'skipped'
        AND (
          d.executor_reason LIKE 'auto:%'
          OR d.executor_reason = 'auto_session_active'
        )
        AND d.ts >= sess.started_at
        AND (${sinceEpoch}::float8 <= 0 OR EXTRACT(EPOCH FROM d.ts) > ${sinceEpoch}::float8)
    )
    SELECT id, ts, kind, mint, symbol, message, pnl_sol, source
    FROM (
      SELECT * FROM opens
      UNION ALL SELECT * FROM closes
      UNION ALL SELECT * FROM live_opens
      UNION ALL SELECT * FROM live_closes
      UNION ALL SELECT * FROM skips
    ) u
    ORDER BY ts DESC
    LIMIT ${sql.raw(String(limit))}
  `);

  type Raw = {
    id: string;
    ts: Date | string;
    kind: AutoTradeLogEntry["kind"];
    mint: string | null;
    symbol: string | null;
    message: string;
    pnl_sol: number | null;
    source: AutoTradeLogEntry["source"];
  };

  const fromDb = (res as unknown as { rows: Raw[] }).rows.map((r) => ({
    id: r.id,
    ts: r.ts instanceof Date ? r.ts.toISOString() : String(r.ts),
    kind: r.kind,
    mint: r.mint,
    symbol: r.symbol,
    message: r.kind === "skip" ? autoSkipReasonLabel(r.message) : r.message,
    pnlSol: r.pnl_sol,
    source: r.source,
  }));

  const statsRow = await getDb()
    .select({ stats: autoSessions.stats })
    .from(autoSessions)
    .where(eq(autoSessions.id, BigInt(sessionId)))
    .limit(1);
  const recent = (statsRow[0]?.stats as AutoSessionStats | undefined)?.recentFilterSkips ?? [];
  const filterEntries: AutoTradeLogEntry[] = recent.map((f, i) => ({
    id: `filter-${i}-${f.ts}`,
    ts: f.ts,
    kind: "skip",
    mint: f.mint,
    symbol: null,
    message: `Retryable filter: ${f.reason}`,
    pnlSol: null,
    source: "system",
  }));

  const merged = [...fromDb, ...filterEntries];
  merged.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  return merged.slice(0, limit);
}
