"use client";

import type { Candle } from "@/lib/chart/types";
import { pctChange } from "@/lib/chart/engine/indicators";
import { CHART_THEME } from "@/components/chart/chartTheme";
import { fmtAxisMcap, fmtPct } from "@/components/chart/format";

function fmtVol(v: number): string {
  if (v >= 1000) return `${(v / 1000).toFixed(1)}K`;
  return v.toFixed(2);
}

export function ChartOhlcvLegend({
  candle,
  timeSec,
}: {
  candle: Candle | null;
  timeSec: number | null;
}) {
  if (!candle) return null;

  const chg = pctChange(candle.open, candle.close);
  const up = candle.close >= candle.open;

  return (
    <div
      className="pointer-events-none absolute left-2 top-2 z-10 flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded px-1.5 py-1 font-mono text-[10px]"
      style={{ background: "rgba(17,24,32,0.92)", border: `1px solid ${CHART_THEME.border}` }}
    >
      {timeSec != null && (
        <span style={{ color: CHART_THEME.text }}>
          {new Date(timeSec * 1000).toLocaleString([], {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          })}
        </span>
      )}
      <span style={{ color: CHART_THEME.text }}>O {fmtAxisMcap(candle.open)}</span>
      <span style={{ color: CHART_THEME.text }}>H {fmtAxisMcap(candle.high)}</span>
      <span style={{ color: CHART_THEME.text }}>L {fmtAxisMcap(candle.low)}</span>
      <span style={{ color: up ? CHART_THEME.up : CHART_THEME.down }}>C {fmtAxisMcap(candle.close)}</span>
      <span style={{ color: CHART_THEME.text }}>V {fmtVol(candle.volume)} SOL</span>
      {chg != null && (
        <span style={{ color: chg >= 0 ? CHART_THEME.up : CHART_THEME.down }}>{fmtPct(chg)}</span>
      )}
    </div>
  );
}

export function findCandleAtTime(candles: Candle[], timeSec: number): Candle | null {
  let best: Candle | null = null;
  for (const c of candles) {
    if (c.time === timeSec) return c;
    if (c.time <= timeSec) best = c;
    else break;
  }
  return best;
}

export function latestBar(candles: Candle[]): Candle | null {
  return candles.length ? candles[candles.length - 1]! : null;
}
