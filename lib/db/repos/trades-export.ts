import "server-only";

import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { PAPER_TRADES_READ } from "@/lib/db/paper-read";

export type ExportTradeRow = {
  id: string;
  source: string;
  mint: string;
  opened_at: string | null;
  closed_at: string | null;
  side: string | null;
  size_sol: number;
  entry_price: number | null;
  exit_price: number | null;
  pnl_sol: number | null;
  fees_sol: number | null;
  exit_reason: string;
  tx_open: string;
  tx_close: string;
  dry_run: boolean;
};

export async function fetchExportTradeRows(opts: {
  source: "paper" | "live" | "all";
  status: "open" | "closed" | "all";
}): Promise<ExportTradeRow[]> {
  const wantPaper = opts.source === "all" || opts.source === "paper";
  const wantLive = opts.source === "all" || opts.source === "live";
  const statusFilter =
    opts.status === "all"
      ? sql`(true)`
      : opts.status === "open"
        ? sql`status = 'open'`
        : sql`status = 'closed'`;

  const rows: ExportTradeRow[] = [];
  if (wantPaper) {
    const r = await getDb().execute(sql`
      SELECT
        id::text AS id,
        'paper' AS source,
        mint,
        to_char(opened_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS opened_at,
        to_char(closed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS closed_at,
        side,
        size_sol::float8 AS size_sol,
        entry_v_sol::float8 AS entry_price,
        exit_v_sol::float8 AS exit_price,
        pnl_sol::float8 AS pnl_sol,
        0::float8 AS fees_sol,
        COALESCE(exit_reason, '') AS exit_reason,
        '' AS tx_open,
        '' AS tx_close,
        false AS dry_run
      FROM ${sql.raw(PAPER_TRADES_READ)}
      WHERE ${statusFilter}
      ORDER BY opened_at DESC
    `);
    rows.push(...(r as unknown as { rows: ExportTradeRow[] }).rows);
  }
  if (wantLive) {
    const r = await getDb().execute(sql`
      SELECT
        id::text AS id,
        'live' AS source,
        mint,
        to_char(opened_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS opened_at,
        to_char(closed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS closed_at,
        side,
        size_sol::float8 AS size_sol,
        entry_price::float8 AS entry_price,
        exit_price::float8 AS exit_price,
        pnl_sol::float8 AS pnl_sol,
        fees_sol::float8 AS fees_sol,
        COALESCE(exit_reason, '') AS exit_reason,
        COALESCE(tx_signature_open, '') AS tx_open,
        COALESCE(tx_signature_close, '') AS tx_close,
        dry_run
      FROM live_trades
      WHERE ${statusFilter}
      ORDER BY opened_at DESC
    `);
    rows.push(...(r as unknown as { rows: ExportTradeRow[] }).rows);
  }
  return rows;
}

export function exportTradeRowToCsv(r: ExportTradeRow): string {
  const cells = [
    r.id,
    r.source,
    r.mint,
    r.opened_at ?? "",
    r.closed_at ?? "",
    r.side ?? "",
    fmt(r.size_sol),
    fmt(r.entry_price),
    fmt(r.exit_price),
    fmt(r.pnl_sol),
    fmt(r.fees_sol),
    csvEscape(r.exit_reason),
    r.tx_open,
    r.tx_close,
    r.dry_run ? "true" : "false",
  ];
  return cells.join(",");
}

function fmt(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "";
  return String(v);
}

function csvEscape(s: string): string {
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export const EXPORT_TRADES_CSV_HEADER =
  "id,source,mint,opened_at,closed_at,side,size_sol,entry_price,exit_price,pnl_sol,fees_sol,exit_reason,tx_open,tx_close,dry_run\n";
