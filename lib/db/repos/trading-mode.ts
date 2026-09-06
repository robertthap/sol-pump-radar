import "server-only";
import { eq, sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { PAPER_TRADES_READ } from "@/lib/db/paper-read";
import { userSettings } from "@/lib/db/schema";

export type UiTradingMode = "demo" | "real";

const KEY_MODE = "ui_trading_mode";
const KEY_DEMO_START = "demo_start_sol";
const KEY_DEMO_OFFSET = "demo_pnl_offset";

const DEFAULT_DEMO_START = 10;

/** Demo-wallet predicate on paper_positions.entry_features JSONB. */
export const DEMO_WALLET_TRADE_WHERE = `(
  entry_features->>'ui_mode' = 'demo'
  OR (
    COALESCE(entry_features->>'auto', 'false') = 'true'
    AND COALESCE(entry_features->>'session_mode', '') = 'paper'
    AND entry_features->>'shadow_of' IS NULL
    AND COALESCE(entry_features->>'purpose', '') <> 'shadow_learn'
  )
)`;

/** Inline demo-wallet filter for Drizzle sql templates. */
export const demoWalletTradeSql = sql.raw(DEMO_WALLET_TRADE_WHERE);

export async function getUiTradingMode(): Promise<UiTradingMode | null> {
  const rows = await getDb()
    .select()
    .from(userSettings)
    .where(eq(userSettings.key, KEY_MODE))
    .limit(1);
  const v = rows[0]?.value;
  if (v === "demo" || v === "real") return v;
  return null;
}

/**
 * True only when there is a LIVE trading session for `mode` — an active
 * auto-trader session for the matching executor, or an open position. A persisted
 * mode setting alone (the user picked Demo/Real on a previous run) does NOT count,
 * so a freshly-started, idle app shows the wallet chooser rather than a phantom
 * "ongoing session".
 */
export async function hasActiveTradingSession(mode: UiTradingMode | null): Promise<boolean> {
  if (mode == null) return false;
  const hasRows = (r: unknown): boolean =>
    ((r as { rows?: unknown[] }).rows?.length ?? 0) > 0;

  const wantMode = mode === "real" ? "live" : "paper";
  const auto = await getDb().execute(
    sql`SELECT 1 FROM auto_sessions WHERE status = 'active' AND mode = ${wantMode} LIMIT 1`,
  );
  if (hasRows(auto)) return true;

  if (mode === "demo") {
    const open = await getDb().execute(
      sql`SELECT 1 FROM paper_positions WHERE state = 'OPEN' AND ${demoWalletTradeSql} LIMIT 1`,
    );
    return hasRows(open);
  }
  const live = await getDb().execute(
    sql`SELECT 1 FROM live_trades WHERE status <> 'closed' LIMIT 1`,
  );
  return hasRows(live);
}

export async function setUiTradingMode(mode: UiTradingMode): Promise<void> {
  await getDb()
    .insert(userSettings)
    .values({ key: KEY_MODE, value: mode, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: userSettings.key,
      set: { value: mode, updatedAt: new Date() },
    });
}

/** Clears UI trading mode so the user must pick Demo or Real again on the home page. */
export async function clearUiTradingMode(): Promise<void> {
  await getDb().delete(userSettings).where(eq(userSettings.key, KEY_MODE));
}

export async function getDemoStartSol(): Promise<number> {
  const rows = await getDb()
    .select()
    .from(userSettings)
    .where(eq(userSettings.key, KEY_DEMO_START))
    .limit(1);
  const n = Number(rows[0]?.value);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_DEMO_START;
}

export async function setDemoStartSol(amount: number): Promise<void> {
  if (amount <= 0 || amount > 10_000) throw new Error("demo_start_sol out of range");
  await getDb()
    .insert(userSettings)
    .values({ key: KEY_DEMO_START, value: String(amount), updatedAt: new Date() })
    .onConflictDoUpdate({
      target: userSettings.key,
      set: { value: String(amount), updatedAt: new Date() },
    });
}

async function getDemoPnlOffset(): Promise<number> {
  const rows = await getDb()
    .select()
    .from(userSettings)
    .where(eq(userSettings.key, KEY_DEMO_OFFSET))
    .limit(1);
  const n = Number(rows[0]?.value);
  return Number.isFinite(n) ? n : 0;
}

async function setDemoPnlOffset(offset: number): Promise<void> {
  await getDb()
    .insert(userSettings)
    .values({ key: KEY_DEMO_OFFSET, value: String(offset), updatedAt: new Date() })
    .onConflictDoUpdate({
      target: userSettings.key,
      set: { value: String(offset), updatedAt: new Date() },
    });
}

/**
 * Worker-only: close open demo-wallet positions via paperClose and reset PnL offset.
 * Invoked by demo-reset-listener after DEMO_RESET_REQUESTED.
 */
/**
 * Full "new demo account" reset: wipe the USER's demo trading state (open + closed
 * positions, fills, wallet balance, session stats) so it looks like a brand-new
 * account. The SYSTEM's learning is intentionally PRESERVED — tuner_changes,
 * learned_rules, decision_log, trade_outcomes, and all market data are untouched,
 * so the bot keeps everything it has learned. (Learning is system state, not the
 * user's wallet.)
 */
export async function executeDemoWalletReset(): Promise<DemoAccountSnapshot> {
  const startSol = await getDemoStartSol();

  // 1. Delete the demo wallet's trade history (open + closed) + their fills.
  //    Scoped to the demo wallet only — live trades + shadow-learn are untouched.
  await getDb().execute(sql`
    DELETE FROM paper_trade_fills
    WHERE position_id IN (SELECT id FROM paper_positions WHERE ${demoWalletTradeSql})
  `);
  // Sampled P&L paths belong to those positions; leaving them behind orphans
  // research data against ids that no longer exist. Deleted BEFORE the positions
  // so the subquery can still resolve them.
  await getDb()
    .execute(sql`
      DELETE FROM position_marks
      WHERE position_id IN (SELECT id FROM paper_positions WHERE ${demoWalletTradeSql})
    `)
    .catch(() => undefined);
  await getDb().execute(sql`DELETE FROM paper_positions WHERE ${demoWalletTradeSql}`);
  // Self-healing: sweep marks whose position no longer exists at all. Resets
  // before this cleanup left orphans behind, and "reset the account" should
  // leave nothing pointing at trades that are gone.
  await getDb()
    .execute(sql`
      DELETE FROM position_marks m
      WHERE NOT EXISTS (SELECT 1 FROM paper_positions p WHERE p.id = m.position_id)
    `)
    .catch(() => undefined);

  // 2. Reset the virtual wallet ledger + the display PnL offset to a fresh start.
  await setDemoPnlOffset(0);
  await getDb()
    .execute(sql`
      UPDATE paper_portfolio
      SET balance_sol = ${startSol}, realized_pnl_sol = 0, unrealized_pnl_sol = 0,
          equity_sol = ${startSol}, peak_equity_sol = ${startSol}, wins = 0, losses = 0,
          updated_at = now()
      WHERE id = 1
    `)
    .catch(() => undefined);

  // 3. Zero the active auto session's stats so the hero + insights show a fresh
  //    account, while keeping the session ACTIVE so auto-trade keeps running.
  await getDb()
    .execute(sql`UPDATE auto_sessions SET stats = '{}'::jsonb WHERE status = 'active'`)
    .catch(() => undefined);

  return fetchDemoAccount();
}

export type DemoAccountSnapshot = {
  startSol: number;
  /** Cash available for new trades (start + closed PnL − locked in open positions). */
  balanceSol: number;
  /** Mark-to-market total: balance + current value of open positions. */
  equitySol: number;
  realizedPnlSol: number;
  unrealizedPnlSol: number;
  lockedSol: number;
  openPositions: number;
  closedTrades: number;
};

/** Virtual demo wallet — manual demo + auto-trade paper sessions (not shadow learner). */
export async function fetchDemoAccount(): Promise<DemoAccountSnapshot> {
  const startSol = await getDemoStartSol();
  const offset = await getDemoPnlOffset();
  const { sql: drizzleSql } = await import("drizzle-orm");
  const { paperPnlSol } = await import("@/lib/paper/math");
  const { riskBudgetFor } = await import("@/lib/risk/presets");
  const { env } = await import("@/lib/env");
  const budget = riskBudgetFor(env().RISK_PRESET);

  const res = await getDb().execute(drizzleSql`
    SELECT
      COALESCE(SUM(realized_pnl_sol) FILTER (WHERE state = 'CLOSED'), 0)::float8 AS realized,
      COALESCE(SUM(notional_sol) FILTER (WHERE state = 'OPEN'), 0)::float8 AS locked,
      COUNT(*) FILTER (WHERE state = 'OPEN')::int AS open_n,
      COUNT(*) FILTER (WHERE state = 'CLOSED')::int AS closed_n
    FROM paper_positions
    WHERE ${demoWalletTradeSql}
  `);
  type Raw = {
    realized: number;
    locked: number;
    open_n: number;
    closed_n: number;
  };
  const row = (res as unknown as { rows: Raw[] }).rows[0]!;

  const openRes = await getDb().execute(drizzleSql`
    SELECT p.mint::text AS mint, p.notional_sol::float8 AS size_sol, p.entry_price::float8 AS entry_v_sol,
      lat.v_now::float8 AS v_now
    FROM paper_positions p
    LEFT JOIN LATERAL (
      SELECT v_sol_after::float8 AS v_now
      FROM events e
      WHERE e.mint = p.mint AND e.v_sol_after IS NOT NULL
      ORDER BY e.ts DESC
      LIMIT 1
    ) lat ON TRUE
    WHERE p.state = 'OPEN' AND ${demoWalletTradeSql}
  `);
  type OpenRow = { mint: string; size_sol: number; entry_v_sol: number | null; v_now: number | null };
  let unrealizedPnlSol = 0;
  for (const o of (openRes as unknown as { rows: OpenRow[] }).rows) {
    if (o.entry_v_sol == null || o.v_now == null) continue;
    const { pnlSol } = paperPnlSol({
      sizeSol: o.size_sol,
      entryVSol: o.entry_v_sol,
      currentVSol: o.v_now,
      pumpFeesPct: budget.pumpFeesPct,
      paperSlippagePct: budget.paperSlippagePct,
    });
    unrealizedPnlSol += pnlSol;
  }

  const effectiveRealized = row.realized - offset;
  const balanceSol = startSol + effectiveRealized - row.locked;
  const equitySol = startSol + effectiveRealized + unrealizedPnlSol;
  return {
    startSol,
    balanceSol,
    equitySol,
    realizedPnlSol: effectiveRealized,
    unrealizedPnlSol,
    lockedSol: row.locked,
    openPositions: row.open_n,
    closedTrades: row.closed_n,
  };
}

/** Header poll — cash balance only, no mark-to-market lateral joins. */
export async function fetchDemoAccountLite(): Promise<DemoAccountSnapshot> {
  const startSol = await getDemoStartSol();
  const offset = await getDemoPnlOffset();
  const res = await getDb().execute(sql`
    SELECT
      COALESCE(SUM(realized_pnl_sol) FILTER (WHERE state = 'CLOSED'), 0)::float8 AS realized,
      COALESCE(SUM(notional_sol) FILTER (WHERE state = 'OPEN'), 0)::float8 AS locked,
      COUNT(*) FILTER (WHERE state = 'OPEN')::int AS open_n,
      COUNT(*) FILTER (WHERE state = 'CLOSED')::int AS closed_n
    FROM paper_positions
    WHERE ${demoWalletTradeSql}
  `);
  type Raw = { realized: number; locked: number; open_n: number; closed_n: number };
  const row = (res as unknown as { rows: Raw[] }).rows[0]!;
  const effectiveRealized = row.realized - offset;
  const balanceSol = startSol + effectiveRealized - row.locked;
  return {
    startSol,
    balanceSol,
    equitySol: balanceSol + row.locked,
    realizedPnlSol: effectiveRealized,
    unrealizedPnlSol: 0,
    lockedSol: row.locked,
    openPositions: row.open_n,
    closedTrades: row.closed_n,
  };
}

export type RealGateStats = {
  closedDemoTrades: number;
  demoDays: number;
  meetsDemoTime: boolean;
  meetsTradeCount: boolean;
  recommended: boolean;
};

/** Stats for Real-mode unlock checklist (soft gate — personal tool). */
export async function fetchRealGateStats(): Promise<RealGateStats> {
  const r = await getDb().execute(sql`
    SELECT
      COUNT(*) FILTER (WHERE status = 'closed')::int AS closed_demo_trades,
      MIN(opened_at) FILTER (WHERE status IN ('open', 'closed')) AS first_demo_trade
    FROM ${sql.raw(PAPER_TRADES_READ)}
    WHERE entry_features->>'ui_mode' = 'demo'
       OR (
         COALESCE(entry_features->>'auto', 'false') = 'true'
         AND COALESCE(entry_features->>'session_mode', '') = 'paper'
       )
  `);
  type Row = { closed_demo_trades: number; first_demo_trade: string | null };
  const row = (r as unknown as { rows: Row[] }).rows[0];
  const closed = row?.closed_demo_trades ?? 0;
  const first = row?.first_demo_trade ? new Date(row.first_demo_trade).getTime() : null;
  const demoDays =
    first != null ? Math.floor((Date.now() - first) / (24 * 60 * 60 * 1000)) : 0;
  const meetsDemoTime = demoDays >= 7;
  const meetsTradeCount = closed >= 20;
  return {
    closedDemoTrades: closed,
    demoDays,
    meetsDemoTime,
    meetsTradeCount,
    recommended: meetsDemoTime || meetsTradeCount,
  };
}

/** True when the demo wallet already has an open position on this mint. */
export async function hasOpenDemoPosition(mint: string): Promise<boolean> {
  const r = await getDb().execute(sql`
    SELECT 1 FROM paper_positions
    WHERE state = 'OPEN' AND mint = ${mint} AND entry_features->>'ui_mode' = 'demo'
    LIMIT 1
  `);
  return (r as unknown as { rows: unknown[] }).rows.length > 0;
}
