"use client";

import { useMissionControl } from "@/lib/mission/MissionControlProvider";

const COLORS = ["#22d3ee", "#34d399", "#fbbf24"];

function polyline(points: Array<{ t: number; v: number }>, w: number, h: number): string {
  if (points.length < 2) return "";
  const minT = points[0].t;
  const maxT = points[points.length - 1].t || minT + 1;
  const xs = points.map((p) => ((p.t - minT) / (maxT - minT || 1)) * (w - 8) + 4);
  const ys = points.map((p) => h - 8 - p.v * (h - 16));
  return xs.map((x, i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${ys[i].toFixed(1)}`).join(" ");
}

export function RankVelocityChart() {
  const { data } = useMissionControl();
  const series = data?.rankSeries ?? [];
  const w = 520;
  const h = 140;

  return (
    <section className="mission-panel">
      <header className="mission-panel-head">
        <h2 className="mission-title">Rank velocity</h2>
        <span className="mission-sub">Percentile over time — edge before price</span>
      </header>
      {series.length === 0 ? (
        <p className="px-3 py-6 text-center text-xs text-zinc-500">
          Rank history appears after intelligence commits record material changes.
        </p>
      ) : (
        <div className="px-2 pb-3">
          <svg viewBox={`0 0 ${w} ${h}`} className="w-full" role="img" aria-label="Rank percentile chart">
            {[0.25, 0.5, 0.75, 1].map((g) => (
              <line
                key={g}
                x1={4}
                x2={w - 4}
                y1={h - 8 - g * (h - 16)}
                y2={h - 8 - g * (h - 16)}
                stroke="rgb(63 63 70 / 0.5)"
                strokeDasharray="4 4"
              />
            ))}
            {series.map((s, idx) => (
              <path
                key={s.mint}
                d={polyline(s.points, w, h)}
                fill="none"
                stroke={COLORS[idx % COLORS.length]}
                strokeWidth={2}
              />
            ))}
          </svg>
          <ul className="mt-2 flex flex-wrap gap-3 text-[10px]">
            {series.map((s, idx) => (
              <li key={s.mint} className="flex items-center gap-1.5 text-zinc-400">
                <span
                  className="inline-block h-2 w-2 rounded-full"
                  style={{ background: COLORS[idx % COLORS.length] }}
                />
                {s.symbol}{" "}
                <span className="font-mono text-zinc-500">
                  {((s.points[s.points.length - 1]?.v ?? 0) * 100).toFixed(0)}%
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
