"use client";

import { useId, useMemo } from "react";
import type { SeriesPoint } from "@/components/ticker/TickerProvider";

const W = 500;
const H = 64;

/** Decorative, transparent realtime market-cap trace behind an open position. */
export function PositionMiniChart({ series }: { series: SeriesPoint[] }) {
  const gradientId = useId();
  const geom = useMemo(() => {
    if (series.length < 2) return null;
    const recent = series.slice(-90);
    const values = recent.map(([, value]) => value);
    let min = Math.min(...values);
    let max = Math.max(...values);
    if (max - min < 1e-9) {
      min -= 1;
      max += 1;
    }
    const pad = (max - min) * 0.15;
    min -= pad;
    max += pad;
    const x = (index: number) => (index / (values.length - 1)) * W;
    const y = (value: number) => H - ((value - min) / (max - min)) * H;
    const points = values.map((value, index) => `${x(index).toFixed(1)},${y(value).toFixed(1)}`);
    const line = `M${points.join(" L")}`;
    const area = `${line} L${W},${H} L0,${H} Z`;
    return { line, area, up: values.at(-1)! >= values[0]! };
  }, [series]);

  if (!geom) return null;
  const color = geom.up ? "rgb(34 197 94)" : "rgb(244 84 84)";

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className="pointer-events-none absolute inset-0 h-full w-full opacity-25"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.4" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={geom.area} fill={`url(#${gradientId})`} />
      <path d={geom.line} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
