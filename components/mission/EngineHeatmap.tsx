"use client";

import { useMissionControl } from "@/lib/mission/MissionControlProvider";
import { lifecycleOrder, stateVisual } from "@/lib/ui/momentum-states";

const LIFECYCLE = [
  "cold",
  "launching",
  "early_breakout",
  "acceleration",
  "trend",
  "parabolic",
  "exhaustion",
  "collapse",
];

export function EngineHeatmap() {
  const { data } = useMissionControl();
  const map = new Map((data?.heatmap ?? []).map((h) => [h.state, h.n]));
  const max = Math.max(1, ...[...map.values()]);

  return (
    <section className="mission-panel">
      <header className="mission-panel-head">
        <h2 className="mission-title">Regime heatmap</h2>
        <span className="mission-sub">Tokens per lifecycle state</span>
      </header>
      <ul className="space-y-1.5 px-3 pb-3">
        {LIFECYCLE.sort((a, b) => lifecycleOrder(a) - lifecycleOrder(b)).map((state) => {
          const n = map.get(state) ?? 0;
          const vis = stateVisual(state);
          const pct = (n / max) * 100;
          return (
            <li key={state} className="flex items-center gap-2 text-xs">
              <span className={`w-20 font-mono text-[10px] font-bold ${vis.text}`}>{vis.short}</span>
              <div className="relative h-4 flex-1 overflow-hidden rounded bg-zinc-900">
                <div
                  className={`absolute inset-y-0 left-0 ${vis.bar} opacity-80 transition-all duration-500`}
                  style={{ width: `${pct}%` }}
                />
              </div>
              <span className="w-8 text-right font-mono text-zinc-400">{n}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
