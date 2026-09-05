"use client";

import { useId, useMemo } from "react";
import { sparklineState } from "@/lib/auto/ticker-snapshot";
import type { SeriesPoint } from "@/components/ticker/TickerProvider";
import { signedSol } from "@/components/ticker/format";

/**
 * Lightweight P&L sparkline - a financial ticker line, not a market chart.
 *
 * Plain SVG, no library, no axes, no grid, no indicators. Under 1,000 points
 * (we cap at 600) SVG is the right tool. The line and a 20%-opacity fill to
 * the zero baseline show direction; the fill colour follows the LAST value so
 * the state reads at a glance, and the hero numbers beside it carry the exact
 * figures (colour is never the only signal). No entrance animation: data is
 * readable immediately and reduced-motion needs nothing special.
 */
type Props = {
  series: SeriesPoint[];
  /** Named series for the caption and the screen-reader summary. */
  label: string;
  height?: number;
};

const W = 600;

export function PnlSparkline({ series, label, height = 96 }: Props) {
  const gradId = useId();
  const state = sparklineState(series.map(([, v]) => v));

  const geom = useMemo(() => {
    if (series.length < 2) return null;
    const vals = series.map(([, v]) => v);
    let min = Math.min(0, ...vals);
    let max = Math.max(0, ...vals);
    if (max - min < 1e-9) {
      max += 1e-6;
      min -= 1e-6;
    }
    const pad = (max - min) * 0.08;
    min -= pad;
    max += pad;
    const H = height;
    const y = (v: number) => H - ((v - min) / (max - min)) * H;
    const x = (i: number) => (i / (series.length - 1)) * W;
    const pts = vals.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
    const zeroY = y(0);
    const line = `M${pts.join(" L")}`;
    const area = `${line} L${W},${zeroY.toFixed(1)} L0,${zeroY.toFixed(1)} Z`;
    return { line, area, zeroY, H, first: vals[0]!, last: vals[vals.length - 1]!, lastY: y(vals[vals.length - 1]!), min, max };
  }, [series, height]);

  const stroke = state === "positive" ? "rgb(34 197 94)" : state === "negative" ? "rgb(244 84 84)" : "rgb(143 148 160)";

  if (!geom) {
    return (
      <div
        className="flex items-center justify-center rounded-md border border-dashed border-border text-xs text-muted"
        style={{ height }}
        role="img"
        aria-label={`${label}: building live history, no chart yet`}
      >
        Building live history{"…"}
      </div>
    );
  }

  const change = geom.last - geom.first;
  const summary = `${label}: ${signedSol(geom.last, 4)} now, ${signedSol(change, 4)} over the last ${series.length} samples.`;

  return (
    <svg
      viewBox={`0 0 ${W} ${geom.H}`}
      preserveAspectRatio="none"
      className="block w-full"
      style={{ height }}
      role="img"
      aria-label={summary}
    >
      <title>{summary}</title>
      <defs>
        {/* Fill is strongest at the line and fades toward the zero baseline, whichever side of it the line is on. */}
        <linearGradient id={gradId} x1="0" y1={state === "negative" ? "1" : "0"} x2="0" y2={state === "negative" ? "0" : "1"}>
          <stop offset="0%" stopColor={stroke} stopOpacity="0.28" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0.02" />
        </linearGradient>
      </defs>
      {/* zero baseline - subtle so it never competes with the data */}
      <line x1="0" x2={W} y1={geom.zeroY} y2={geom.zeroY} stroke="rgb(38 41 50)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
      <path d={geom.area} fill={`url(#${gradId})`} />
      <path d={geom.line} fill="none" stroke={stroke} strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
      {/* "now" marker - static, draws the eye to the latest value */}
      <circle cx={W} cy={geom.lastY} r="3.5" fill={stroke} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
