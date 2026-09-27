import "server-only";

import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { PAPER_TRADES_READ } from "@/lib/db/paper-read";
import { env } from "@/lib/env";
import { paperPnlSol } from "@/lib/paper/math";
import { riskBudgetFor } from "@/lib/risk/presets";
import { fetchLivePrices, type LivePrice } from "@/lib/pricing/live-price";
import {
  getActiveSession,
  getLatestSession,
} from "@/lib/db/repos/auto-sessions";
import { getUiTradingMode } from "@/lib/db/repos/trading-mode";

/** How old the worker's per-tick mark may be and still be shown as live. */
const PRICE_FRESH_MS = 15_000;

export type AutoTradeMarker = {
  id: string;
  ts: string;
  side: "buy" | "sell";
  vSol: number | null;
};

export type AutoSessionPosition = {
  id: string;
  mint: string;
  symbol: string | null;
  name: string | null;
  source: "paper" | "live";
  status: "open" | "closed";
  sizeSol: number;
  entryVSol: number | null;
  exitVSol: number | null;
  currentVSol: number | null;
  entryMcapUsd: number | null;
  currentMcapUsd: number | null;
  bondingPct: number | null;
  pnlSol: number | null;
  pctOfSize: number | null;
  exitReason: string | null;
  openedAt: string;
  closedAt: string | null;
  action: string | null;
  imageUri: string | null;
  markers: AutoTradeMarker[];
  strategyName?: string | null;
  strategyReason?: string | null;
  researchStatus?: string | null;
  added?: boolean;
};

export type AutoSessionClosedPosition = Pick<
  AutoSessionPosition,
  | "id"
  | "mint"
  | "symbol"
  | "name"
  | "source"
  | "sizeSol"
  | "entryMcapUsd"
  | "currentMcapUsd"
  | "pnlSol"
  | "exitReason"
  | "openedAt"
  | "closedAt"
  | "strategyName"
>;

export type AutoSessionPositionsSnapshot = {
  active: boolean;
  sessionId: string | null;
  open: AutoSessionPosition[];
  closed: AutoSessionPosition[];
  stats: {
    openCount: number;
    closedCount: number;
    realizedPnlSol: number;
    unrealizedPnlSol: number;
    totalPnlSol: number;
  };
};

import { mcapUsdFromVSol } from "@/lib/dex/curve-mcap";

function markersForTrade(opts: {
  id: string;
  openedAt: string;
  closedAt: string | null;
  entryVSol: number | null;
  exitVSol: number | null;
}): AutoTradeMarker[] {
  const out: AutoTradeMarker[] = [
    {
      id: `${opts.id}-buy`,
      ts: opts.openedAt,
      side: "buy",
      vSol: opts.entryVSol,
    },
  ];
  if (opts.closedAt) {
    out.push({
      id: `${opts.id}-sell`,
      ts: opts.closedAt,
      side: "sell",
      vSol: opts.exitVSol,
    });
  }
  return out;
}

export async function fetchAutoSessionPositions(
  sessionId: string,
  limit = 40,
): Promise<Omit<AutoSessionPositionsSnapshot, "active" | "sessionId">> {
  const cap = Math.min(60, Math.max(5, limit));
  const res = await getDb().execute(sql`
    (
      SELECT
        p.id::text AS id,
        p.mint::text AS mint,
        t.symbol::text AS symbol,
        t.name::text AS name,
        'paper'::text AS source,
        p.status::text AS status,
        p.size_sol::float8 AS size_sol,
        p.entry_v_sol::float8 AS entry_v_sol,
        p.exit_v_sol::float8 AS exit_v_sol,
        p.pnl_sol::float8 AS pnl_sol,
        p.current_v_sol::float8 AS current_v_sol,
        p.exit_reason::text AS exit_reason,
        to_char(p.opened_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS opened_at,
        to_char(p.closed_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS closed_at,
        p.entry_features AS entry_features
      FROM ${sql.raw(PAPER_TRADES_READ)} p
      LEFT JOIN tokens t ON t.mint = p.mint
      WHERE p.entry_features->>'session_id' = ${sessionId}
        AND COALESCE(p.entry_features->>'auto', 'true') = 'true'
        AND p.entry_features->>'shadow_of' IS NULL
    )
    UNION ALL
    (
      SELECT
        l.id::text,
        l.mint::text,
        t.symbol::text,
        t.name::text,
        'live'::text,
        -- pending (unconfirmed buy), pending_close and close_failed still hold or
        -- may hold tokens: show them with the open positions, not as closed.
        CASE WHEN l.status IN ('pending', 'pending_close', 'close_failed') THEN 'open' ELSE l.status END::text,
        l.size_sol::float8,
        l.entry_price::float8,
        l.exit_price::float8,
        l.pnl_sol::float8,
        NULL::float8,
        l.exit_reason::text,
        to_char(l.opened_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        to_char(l.closed_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        NULL::jsonb
      FROM live_trades l
      LEFT JOIN tokens t ON t.mint = l.mint
      WHERE l.session_id = ${sessionId}
    )
    -- Open positions must never be pushed out of the realtime snapshot by a
    -- busy session's closed history. The complete closed list is fetched only
    -- when the user opens the Closed tab.
    ORDER BY status DESC, opened_at DESC NULLS LAST
    LIMIT ${sql.raw(String(cap))}
  `);

  type Raw = {
    id: string;
    mint: string;
    symbol: string | null;
    name: string | null;
    source: "paper" | "live";
    status: string;
    size_sol: number;
    entry_v_sol: number | null;
    exit_v_sol: number | null;
    pnl_sol: number | null;
    current_v_sol: number | null;
    exit_reason: string | null;
    opened_at: string;
    closed_at: string | null;
    entry_features: Record<string, unknown> | null;
  };

  const rows = (res as unknown as { rows: Raw[] }).rows;
  // Resolve every open mint against the real on-chain market. Paper positions
  // normally use the worker's fresh per-tick mark; the on-chain result is the
  // fallback when that mark is missing (notably just-migrated PumpSwap coins).
  const openMints = rows.filter((r) => r.status === "open").map((r) => r.mint);
  const livePrices = openMints.length
    ? await fetchLivePrices(openMints)
    : new Map<string, LivePrice>();

  const budget = riskBudgetFor(env().RISK_PRESET);
  let unrealizedPnlSol = 0;

  const positions: AutoSessionPosition[] = rows.map((r) => {
    const isOpen = r.status === "open";
    // An open paper position shows the price the worker decided on this tick
    // (auto-trader handleExits writes current_price + price_at_ms). A mark older
    // than PRICE_FRESH_MS is not shown as a live number: the row reports unpriced.
    let liveVSol: number | null = null;
    if (isOpen && r.source === "paper") {
      const pricedAt = (r.entry_features as Record<string, unknown> | null)?.price_at_ms;
      const fresh = typeof pricedAt === "number" && Date.now() - pricedAt <= PRICE_FRESH_MS;
      liveVSol = fresh && r.current_v_sol != null && r.current_v_sol > 0 ? r.current_v_sol : null;
      if (liveVSol == null) {
        const p = livePrices.get(r.mint);
        liveVSol = p && p.phase !== "unknown" ? p.vSol : null;
      }
    } else if (isOpen) {
      const p = livePrices.get(r.mint);
      liveVSol = p && p.phase !== "unknown" ? p.vSol : null;
    }
    const currentVSol = isOpen ? liveVSol : r.exit_v_sol;
    // Both mcaps come from vSol at the same SOL rate, so "MC entry → now" moves in
    // step with the P&L instead of mixing a third-party figure into one side.
    const entryMcapUsd = r.entry_v_sol != null ? mcapUsdFromVSol(r.entry_v_sol) : null;
    const currentMcapUsd = currentVSol != null ? mcapUsdFromVSol(currentVSol) : null;

    let pnlSol = r.pnl_sol;
    let pctOfSize: number | null = null;

    if (isOpen && r.entry_features?.research_strategy) {
      const mark = r.entry_features.research_mark_pnl;
      const markedAt = r.entry_features.price_at_ms;
      const markFresh = typeof markedAt === "number" && Date.now() - markedAt <= PRICE_FRESH_MS;
      // Research positions use their strategy's exact pool/tape mark. A public
      // quote may resolve another pool and must never be compared with this
      // trade's entry basis; that produced fake P&L on repeated mints.
      pnlSol =
        r.entry_features.research_status !== "CENSORED" && markFresh && typeof mark === "number"
          ? mark
          : null;
      pctOfSize = pnlSol != null && r.size_sol > 0 ? pnlSol / r.size_sol : null;
      if (pnlSol != null) unrealizedPnlSol += pnlSol;
    } else if (isOpen && r.entry_v_sol != null && currentVSol != null) {
      const calc = paperPnlSol({
        sizeSol: r.size_sol,
        entryVSol: r.entry_v_sol,
        currentVSol,
        pumpFeesPct: budget.pumpFeesPct,
        paperSlippagePct: budget.paperSlippagePct,
      });
      pnlSol = calc.pnlSol;
      pctOfSize = calc.pctOfSize;
      unrealizedPnlSol += calc.pnlSol;
    } else if (isOpen) {
      pnlSol = null; // unpriced this tick; composePortfolio reports it as such
    }
    // Realized totals come from the session-wide query below, not these paginated rows.

    return {
      id: r.id,
      mint: r.mint,
      symbol: r.symbol,
      name: r.name,
      source: r.source,
      status: isOpen ? "open" : "closed",
      sizeSol: r.size_sol,
      entryVSol: r.entry_v_sol,
      exitVSol: isOpen ? currentVSol : r.exit_v_sol,
      currentVSol,
      entryMcapUsd,
      currentMcapUsd,
      bondingPct: null,
      pnlSol,
      pctOfSize,
      exitReason: r.exit_reason,
      openedAt: r.opened_at,
      closedAt: r.closed_at,
      action: ((r.entry_features as Record<string, unknown> | null)?.action as string) ?? null,
      imageUri: null,
      strategyName: typeof r.entry_features?.strategy_name === "string" ? r.entry_features.strategy_name : null,
      strategyReason: typeof r.entry_features?.research_entry_reason === "string" ? r.entry_features.research_entry_reason : null,
      researchStatus: typeof r.entry_features?.research_status === "string" ? r.entry_features.research_status : null,
      added: r.entry_features?.research_added === true,
      markers: markersForTrade({
        id: r.id,
        openedAt: r.opened_at,
        closedAt: r.closed_at,
        entryVSol: r.entry_v_sol,
        exitVSol: isOpen ? currentVSol : r.exit_v_sol,
      }),
    };
  });

  const open = positions.filter((p) => p.status === "open");
  const closed = positions.filter((p) => p.status === "closed");

  // True session-wide counts (independent of pagination LIMIT above). The
  // arrays here are the paginated list for display; counts must reflect the
  // whole session or the UI shows a wrong "Closed 25" when there are 311.
  const totals = await getDb().execute(sql`
    WITH session_trades AS (
      SELECT status::text AS status, pnl_sol::float8 AS pnl_sol
      FROM ${sql.raw(PAPER_TRADES_READ)}
      WHERE entry_features->>'session_id' = ${sessionId}
        AND COALESCE(entry_features->>'auto', 'true') = 'true'
        AND entry_features->>'shadow_of' IS NULL
      UNION ALL
      SELECT
        CASE WHEN status IN ('pending', 'pending_close', 'close_failed') THEN 'open' ELSE status END::text,
        pnl_sol::float8
      FROM live_trades
      WHERE session_id = ${sessionId}
    )
    SELECT
      count(*) FILTER (WHERE status='open')::int   AS open_total,
      count(*) FILTER (WHERE status='closed')::int AS closed_total,
      coalesce(sum(pnl_sol::float8) FILTER (WHERE status='closed'), 0)::float8 AS realized_total
    FROM session_trades
  `);
  const t = (totals as unknown as {
    rows: Array<{ open_total: number; closed_total: number; realized_total: number }>;
  }).rows[0] ?? { open_total: 0, closed_total: 0, realized_total: 0 };
  const failureFees = await getDb().execute(sql`SELECT COALESCE(sum((features->>'failure_fee_sol')::float8),0)::float8 AS fees FROM research_episodes WHERE session_id=${sessionId}::bigint`);
  t.realized_total -= (failureFees as unknown as {rows:Array<{fees:number}>}).rows[0]?.fees ?? 0;
  // Unrealized is summed from the paginated open rows above. The session-wide
  // total is the realized total + any unrealized on paginated opens. (If a
  // session ever exceeds the LIMIT in opens, only the paginated ones contribute
  // unrealized — acceptable since openCount tells the user the true open count.)
  return {
    open,
    closed,
    stats: {
      openCount: t.open_total,
      closedCount: t.closed_total,
      realizedPnlSol: t.realized_total,
      unrealizedPnlSol,
      totalPnlSol: t.realized_total + unrealizedPnlSol,
    },
  };
}

/**
 * Complete closed history for a session. This is intentionally separate from
 * the fast ticker query: closed rows are immutable and only need loading when
 * the Closed tab is viewed, while open positions continue updating every tick.
 */
export async function fetchAutoSessionClosedPositions(
  sessionId: string,
): Promise<AutoSessionClosedPosition[]> {
  const res = await getDb().execute(sql`
    (
      SELECT
        p.id::text AS id,
        p.mint::text AS mint,
        t.symbol::text AS symbol,
        t.name::text AS name,
        'paper'::text AS source,
        p.size_sol::float8 AS size_sol,
        p.entry_v_sol::float8 AS entry_v_sol,
        p.exit_v_sol::float8 AS exit_v_sol,
        p.pnl_sol::float8 AS pnl_sol,
        p.exit_reason::text AS exit_reason,
        to_char(p.opened_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS opened_at,
        to_char(p.closed_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS closed_at,
        p.entry_features AS entry_features
      FROM ${sql.raw(PAPER_TRADES_READ)} p
      LEFT JOIN tokens t ON t.mint = p.mint
      WHERE p.entry_features->>'session_id' = ${sessionId}
        AND COALESCE(p.entry_features->>'auto', 'true') = 'true'
        AND p.entry_features->>'shadow_of' IS NULL
        AND p.status = 'closed'
    )
    UNION ALL
    (
      SELECT
        l.id::text,
        l.mint::text,
        t.symbol::text,
        t.name::text,
        'live'::text,
        l.size_sol::float8,
        l.entry_price::float8,
        l.exit_price::float8,
        l.pnl_sol::float8,
        l.exit_reason::text,
        to_char(l.opened_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        to_char(l.closed_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        NULL::jsonb
      FROM live_trades l
      LEFT JOIN tokens t ON t.mint = l.mint
      WHERE l.session_id = ${sessionId}
        AND l.status = 'closed'
    )
    ORDER BY closed_at DESC NULLS LAST, opened_at DESC
  `);

  type RawClosed = {
    id: string;
    mint: string;
    symbol: string | null;
    name: string | null;
    source: "paper" | "live";
    size_sol: number;
    entry_v_sol: number | null;
    exit_v_sol: number | null;
    pnl_sol: number | null;
    exit_reason: string | null;
    opened_at: string;
    closed_at: string | null;
    entry_features: Record<string, unknown> | null;
  };

  return (res as unknown as { rows: RawClosed[] }).rows.map((r) => ({
    id: r.id,
    mint: r.mint,
    symbol: r.symbol,
    name: r.name,
    source: r.source,
    sizeSol: r.size_sol,
    entryMcapUsd: r.entry_v_sol != null ? mcapUsdFromVSol(r.entry_v_sol) : null,
    currentMcapUsd: r.exit_v_sol != null ? mcapUsdFromVSol(r.exit_v_sol) : null,
    pnlSol: r.pnl_sol,
    exitReason: r.exit_reason,
    openedAt: r.opened_at,
    closedAt: r.closed_at,
    strategyName:
      typeof r.entry_features?.strategy_name === "string" ? r.entry_features.strategy_name : null,
  }));
}

export async function fetchAutoSessionClosedPositionsSnapshot(): Promise<{
  sessionId: string | null;
  closed: AutoSessionClosedPosition[];
}> {
  const uiMode = await getUiTradingMode();
  const wantMode: "paper" | "live" = uiMode === "real" ? "live" : "paper";
  const activeRaw = await getActiveSession();
  const latest = activeRaw ?? (await getLatestSession());
  const session = latest && latest.mode === wantMode ? latest : null;
  if (!session) return { sessionId: null, closed: [] };
  return {
    sessionId: session.id,
    closed: await fetchAutoSessionClosedPositions(session.id),
  };
}

export async function fetchAutoSessionPositionsSnapshot(
  limit = 40,
): Promise<AutoSessionPositionsSnapshot> {
  // Strict Demo/Real isolation: only surface a session that matches the current
  // wallet mode (Demo↔paper, Real↔live). Otherwise a prior mode's positions would
  // display under the wrong banner when the user switches without a new session.
  const uiMode = await getUiTradingMode();
  const wantMode: "paper" | "live" = uiMode === "real" ? "live" : "paper";
  const activeRaw = await getActiveSession();
  const active = activeRaw && activeRaw.mode === wantMode ? activeRaw : null;
  const latest = activeRaw ?? (await getLatestSession());
  const session = latest && latest.mode === wantMode ? latest : null;
  if (!session) {
    return {
      active: false,
      sessionId: null,
      open: [],
      closed: [],
      stats: {
        openCount: 0,
        closedCount: 0,
        realizedPnlSol: 0,
        unrealizedPnlSol: 0,
        totalPnlSol: 0,
      },
    };
  }

  const body = await fetchAutoSessionPositions(session.id, limit);
  return {
    active: !!active,
    sessionId: session.id,
    ...body,
  };
}
