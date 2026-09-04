import { bootDb } from "@/lib/db/client";
import {
  EXPORT_TRADES_CSV_HEADER,
  clampExportLimit,
  exportTradeRowToCsv,
  fetchExportTradeRows,
} from "@/lib/db/repos/trades-export";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * CSV export of all paper + live trades for tax / record-keeping.
 *
 * BOUNDED, and the bound is reported. Rows are capped per source (`?limit=`,
 * default 10,000, hard ceiling 50,000) so a full-history export cannot
 * materialise the whole ledger. A CSV body carries no metadata, so a truncated
 * export would otherwise be indistinguishable from a complete one — a silent
 * wrong answer for the tax/record-keeping use case this exists for. Callers can
 * tell the difference two ways:
 *
 *   X-Export-Row-Limit  the per-source cap applied to this request
 *   X-Export-Complete   "true"  = every matching row is present
 *                       "false" = a source reached the cap; rows are missing
 *
 * and, for a human clicking the download link, "-partial" in the filename.
 *
 * `false` is conservative: it means the cap was reached, which is certain
 * truncation only when one source is selected. Raise `?limit=` (up to 50,000)
 * or narrow the query to get a complete export.
 */
export async function GET(req: Request) {
  await bootDb();
  const { searchParams } = new URL(req.url);
  const sourceRaw = (searchParams.get("source") ?? "all").toLowerCase();
  const statusRaw = (searchParams.get("status") ?? "closed").toLowerCase();
  const source = sourceRaw === "paper" || sourceRaw === "live" ? sourceRaw : "all";
  const status = statusRaw === "open" || statusRaw === "closed" ? statusRaw : statusRaw === "all" ? "all" : "closed";

  // Bounded: the repo clamps this, but let a caller ask for less.
  const limitRaw = Number(searchParams.get("limit"));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : undefined;

  const rows = await fetchExportTradeRows({ source, status, limit });
  const parts = rows.map(exportTradeRowToCsv);
  const csv = EXPORT_TRADES_CSV_HEADER + parts.join("\n") + (parts.length > 0 ? "\n" : "");

  // Each source is capped independently, so reaching the cap in the merged
  // result means at least one source stopped early.
  const appliedLimit = clampExportLimit(limit);
  const complete = rows.length < appliedLimit;
  const day = new Date().toISOString().slice(0, 10);
  const filename = `sol-pump-radar-trades-${day}${complete ? "" : "-partial"}.csv`;

  return new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store",
      "x-export-row-limit": String(appliedLimit),
      "x-export-complete": String(complete),
    },
  });
}
