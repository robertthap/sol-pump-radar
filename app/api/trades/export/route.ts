import { bootDb } from "@/lib/db/client";
import {
  EXPORT_TRADES_CSV_HEADER,
  exportTradeRowToCsv,
  fetchExportTradeRows,
} from "@/lib/db/repos/trades-export";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * CSV export of all paper + live trades for tax / record-keeping.
 */
export async function GET(req: Request) {
  await bootDb();
  const { searchParams } = new URL(req.url);
  const sourceRaw = (searchParams.get("source") ?? "all").toLowerCase();
  const statusRaw = (searchParams.get("status") ?? "closed").toLowerCase();
  const source = sourceRaw === "paper" || sourceRaw === "live" ? sourceRaw : "all";
  const status = statusRaw === "open" || statusRaw === "closed" ? statusRaw : statusRaw === "all" ? "all" : "closed";

  const rows = await fetchExportTradeRows({ source, status });
  const parts = rows.map(exportTradeRowToCsv);
  const csv = EXPORT_TRADES_CSV_HEADER + parts.join("\n") + (parts.length > 0 ? "\n" : "");
  const filename = `sol-pump-radar-trades-${new Date().toISOString().slice(0, 10)}.csv`;
  return new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store",
    },
  });
}
