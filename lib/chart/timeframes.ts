import type { ChartTimeframe } from "@/lib/chart/types";

/** Axiom-style timeframe set (sub-second through daily). */
export const CHART_TIMEFRAMES: ChartTimeframe[] = [
  "1s",
  "5s",
  "15s",
  "1m",
  "5m",
  "15m",
  "1h",
  "4h",
  "1D",
];

export const DEFAULT_CHART_TF: ChartTimeframe = "1m";

export function isChartTimeframe(v: string): v is ChartTimeframe {
  return (CHART_TIMEFRAMES as string[]).includes(v);
}

export function parseChartTimeframe(v: string | null | undefined): ChartTimeframe {
  if (v && isChartTimeframe(v)) return v;
  return DEFAULT_CHART_TF;
}
