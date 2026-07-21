import "server-only";

import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import type { UserTrade } from "@/lib/chart/types";
import { mcapUsdFromVSol } from "@/lib/dex/curve-mcap";
import { unitPriceFromMcap } from "@/lib/chart/data/marketCap";

function priceFromVSol(vSol: number | null | undefined): number {
  const mcap = mcapUsdFromVSol(vSol ?? 0) ?? (vSol ?? 0) * 1e9;
  return unitPriceFromMcap(mcap);
}

async function fetchPaperTrades(mint: string, sessionId?: string | null): Promise<UserTrade[]> {
  // Auto-trader writes session into entry_features->>'session_id' (JSONB), NOT the
  // session_id column (which stays NULL for auto positions).  Match both so that
  // fills from automated entries appear alongside any legacy manual-column entries.
  const sessionFilter = sessionId
    ? sql`AND (p.session_id = ${sessionId}::bigint OR p.entry_features->>'session_id' = ${sessionId})`
    : sql``;

  const res = await getDb().execute(sql`
    SELECT
      f.id::text AS fill_id,
      p.id::text AS position_id,
      p.mint,
      f.fill_type,
      f.fill_price,
      f.notional_sol,
      f.created_at,
      COALESCE(p.correlation_id, '') AS correlation_id
    FROM paper_trade_fills f
    JOIN paper_positions p ON p.id = f.position_id
    WHERE p.mint = ${mint}
    ${sessionFilter}
    ORDER BY f.id ASC
  `);

  type Row = {
    fill_id: string;
    position_id: string;
    mint: string;
    fill_type: string;
    fill_price: number;
    notional_sol: number;
    created_at: Date;
    correlation_id: string;
  };

  return (res as unknown as { rows: Row[] }).rows.map((r) => {
    const side =
      r.fill_type.toLowerCase() === "close" || r.fill_type.toLowerCase() === "sell"
        ? "sell"
        : "buy";
    const mcap = mcapUsdFromVSol(r.fill_price) ?? r.fill_price * 1e9;
    const price = unitPriceFromMcap(mcap);
    return {
      wallet: "",
      token: r.mint,
      side,
      price,
      amount: r.notional_sol,
      timestamp: new Date(r.created_at).getTime(),
      txHash: r.correlation_id || `fill-${r.fill_id}`,
      positionId: r.position_id,
      tradeId: r.fill_id,
    } satisfies UserTrade;
  });
}

async function fetchLiveTrades(mint: string, sessionId?: string | null): Promise<UserTrade[]> {
  const sessionFilter = sessionId ? sql`AND session_id = ${sessionId}` : sql``;
  const res = await getDb().execute(sql`
    SELECT
      id::text AS trade_id,
      mint,
      size_sol,
      entry_price,
      exit_price,
      opened_at,
      closed_at,
      COALESCE(tx_signature_open, buy_signature, '') AS tx_open,
      COALESCE(tx_signature_close, sell_signature, '') AS tx_close
    FROM live_trades
    WHERE mint = ${mint}
    ${sessionFilter}
    ORDER BY id ASC
  `);

  type Row = {
    trade_id: string;
    mint: string;
    size_sol: number;
    entry_price: number | null;
    exit_price: number | null;
    opened_at: Date;
    closed_at: Date | null;
    tx_open: string;
    tx_close: string;
  };

  const out: UserTrade[] = [];
  for (const r of (res as unknown as { rows: Row[] }).rows) {
    out.push({
      wallet: "",
      token: r.mint,
      side: "buy",
      price: priceFromVSol(r.entry_price),
      amount: r.size_sol,
      timestamp: new Date(r.opened_at).getTime(),
      txHash: r.tx_open || `live-open-${r.trade_id}`,
      positionId: r.trade_id,
      tradeId: `${r.trade_id}:open`,
    });
    if (r.closed_at && r.exit_price != null) {
      out.push({
        wallet: "",
        token: r.mint,
        side: "sell",
        price: priceFromVSol(r.exit_price),
        amount: r.size_sol,
        timestamp: new Date(r.closed_at).getTime(),
        txHash: r.tx_close || `live-close-${r.trade_id}`,
        positionId: r.trade_id,
        tradeId: `${r.trade_id}:close`,
      });
    }
  }
  return out;
}

export async function fetchUserTradesForMint(
  mint: string,
  sessionId?: string | null,
): Promise<UserTrade[]> {
  const [paper, live] = await Promise.all([
    fetchPaperTrades(mint, sessionId),
    fetchLiveTrades(mint, sessionId),
  ]);
  return [...paper, ...live].sort((a, b) => {
    if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
    return (a.tradeId ?? "").localeCompare(b.tradeId ?? "");
  });
}
