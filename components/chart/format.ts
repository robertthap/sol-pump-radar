import { PUMP_SUPPLY } from "@/lib/chart/constants";

/** Format a USD market cap as $1.23M / $45.6K / $789. */
export function fmtMcap(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}K`;
  return `$${Math.round(v)}`;
}

/** Format a fractional percentage (0.12 → +12.0%). */
export function fmtPct(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const p = v * 100;
  return `${p >= 0 ? "+" : ""}${p.toFixed(1)}%`;
}

/**
 * Y-axis / crosshair label formatter.  Candle prices are stored as unit price
 * (mcap / supply); multiply back to a readable market cap so the axis reads
 * "$56.1K" instead of "0.0000561".
 */
export function fmtAxisMcap(unitPrice: number): string {
  return fmtMcap(unitPrice * PUMP_SUPPLY);
}
