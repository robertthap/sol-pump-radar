import "server-only";

import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { PAPER_TRADES_READ } from "@/lib/db/paper-read";
import { env } from "@/lib/env";
import { paperPnlSol } from "@/lib/paper/math";
import { pnlFromMcap } from "@/lib/paper/mcap-pnl";
import { riskBudgetFor } from "@/lib/risk/presets";
import { fetchPumpFunCoin } from "@/lib/pump/fun-api";
import {
  getActiveSession,
  getLatestSession,
} from "@/lib/db/repos/auto-sessions";
import { getUiTradingMode } from "@/lib/db/repos/trading-mode";
import { latestVSolBatch } from "@/lib/db/repos/events";

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
};

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

import { mcapUsdFromVSol, effectiveVSolFromMcapUsd } from "@/lib/dex/curve-mcap";

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
        l.status::text,
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
    )
    ORDER BY opened_at DESC NULLS LAST
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
    exit_reason: string | null;
    opened_at: string;
    closed_at: string | null;
    entry_features: Record<string, unknown> | null;
  };

  const rows = (res as unknown as { rows: Raw[] }).rows;
  const openMints = rows.filter((r) => r.status === "open").map((r) => r.mint);
  const latest = await latestVSolBatch(openMints);

  const pumpByMint = new Map<
    string,
    {
      usdMarketCap: number | null;
      bondingPct: number | null;
      imageUri: string | null;
      vSol: number | null;
    }
  >();
  await Promise.all(
    openMints.map(async (mint) => {
      const coin = await fetchPumpFunCoin(mint);
      if (coin) {
        pumpByMint.set(mint, {
          usdMarketCap: coin.usdMarketCap,
          bondingPct: coin.bondingPct,
          imageUri: coin.imageUri,
          vSol: coin.vSol,
        });
      }
    }),
  );

  const budget = riskBudgetFor(env().RISK_PRESET);
  let realizedPnlSol = 0;
  let unrealizedPnlSol = 0;

  const positions: AutoSessionPosition[] = rows.map((r) => {
    const isOpen = r.status === "open";
    const pump = pumpByMint.get(r.mint);
    const currentMcapUsd = pump?.usdMarketCap ?? null;
    const graduated = (pump?.bondingPct ?? 0) >= 100;
    // Current vSol basis must match entry_v_sol (= events.v_sol_after = virtual
    // sol reserves). ON CURVE: use our on-chain resolver. GRADUATED: our vSol
    // freezes at migration, so derive an effective vSol from the live DEX mcap —
    // this keeps PnL tracking the real post-graduation price instead of stalling.
    const liveVSol = isOpen
      ? graduated
        ? (effectiveVSolFromMcapUsd(currentMcapUsd) ?? latest.get(r.mint) ?? null)
        : (latest.get(r.mint) ?? null)
      : null;
    const currentVSol = isOpen ? liveVSol : r.exit_v_sol;
    // Entry mcap: prefer the value stamped at open; else the bonding-curve mcap
    // from the entry vSol (always valid — entry is always on-curve). We never use
    // the back-extrapolation here: it fabricates a huge "entry" on graduated coins.
    const ef = r.entry_features as Record<string, unknown> | null;
    const storedEntryMcap =
      typeof ef?.entry_mcap_usd === "number" && Number.isFinite(ef.entry_mcap_usd) && ef.entry_mcap_usd > 0
        ? (ef.entry_mcap_usd as number)
        : null;
    const entryMcapReal = ef?.entry_mcap_real === true;
    const entryMcapUsd = storedEntryMcap ?? mcapUsdFromVSol(r.entry_v_sol ?? 0);

    let pnlSol = r.pnl_sol;
    let pctOfSize: number | null = null;

    if (isOpen && entryMcapReal && storedEntryMcap != null && currentMcapUsd != null && currentMcapUsd > 0) {
      // Real market-cap PnL (pump/DEX) — accurate on and off the bonding curve.
      const calc = pnlFromMcap({
        sizeSol: r.size_sol,
        entryMcapUsd: storedEntryMcap,
        currentMcapUsd,
        pumpFeesPct: budget.pumpFeesPct,
        paperSlippagePct: budget.paperSlippagePct,
      });
      pnlSol = calc.pnlSol;
      pctOfSize = calc.pctOfSize;
      unrealizedPnlSol += calc.pnlSol;
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
    } else if (!isOpen && pnlSol != null) {
      realizedPnlSol += pnlSol;
    }

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
      bondingPct: pump?.bondingPct ?? null,
      pnlSol,
      pctOfSize,
      exitReason: r.exit_reason,
      openedAt: r.opened_at,
      closedAt: r.closed_at,
      action: ((r.entry_features as Record<string, unknown> | null)?.action as string) ?? null,
      imageUri: pump?.imageUri ?? null,
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
    SELECT
      count(*) FILTER (WHERE status='open')::int   AS open_total,
      count(*) FILTER (WHERE status='closed')::int AS closed_total,
      coalesce(sum(pnl_sol::float8) FILTER (WHERE status='closed'), 0)::float8 AS realized_total
    FROM ${sql.raw(PAPER_TRADES_READ)}
    WHERE entry_features->>'session_id' = ${sessionId}
      AND COALESCE(entry_features->>'auto', 'true') = 'true'
      AND entry_features->>'shadow_of' IS NULL
  `);
  const t = (totals as unknown as {
    rows: Array<{ open_total: number; closed_total: number; realized_total: number }>;
  }).rows[0] ?? { open_total: 0, closed_total: 0, realized_total: 0 };
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
