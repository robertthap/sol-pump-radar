"use client";

import Link from "next/link";
import { useMissionControl } from "@/lib/mission/MissionControlProvider";
import { momentumBars, stateVisual } from "@/lib/ui/momentum-states";

export function MomentumArena() {
  const { data, loading, selectedMint, setSelectedMint } = useMissionControl();
  const rows = data?.arena ?? [];

  return (
    <section className="mission-panel">
      <header className="mission-panel-head">
        <h2 className="mission-title">Live momentum arena</h2>
        <span className="mission-sub">Rank competition — states, not price</span>
      </header>
      <div className="overflow-x-auto">
        <table className="mission-table w-full text-left text-xs">
          <thead>
            <tr className="text-[10px] uppercase tracking-wider text-zinc-500">
              <th className="py-2 pr-2">#</th>
              <th className="py-2 pr-2">Mint</th>
              <th className="py-2 pr-2">State</th>
              <th className="py-2 pr-2">Momentum</th>
              <th className="py-2 pr-2">Rank</th>
              <th className="py-2">Δ rank</th>
            </tr>
          </thead>
          <tbody>
            {loading && rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="py-8 text-center text-zinc-500">
                  Scanning universe…
                </td>
              </tr>
            ) : null}
            {rows.map((row) => {
              const vis = stateVisual(row.state);
              const active = row.mint === selectedMint;
              return (
                <tr
                  key={row.mint}
                  onClick={() => setSelectedMint(row.mint)}
                  className={`mission-row cursor-pointer border-t border-zinc-800/80 transition-colors ${
                    active ? "bg-cyan-500/10" : "hover:bg-zinc-800/40"
                  }`}
                >
                  <td className="py-2 pr-2 font-mono text-zinc-500">#{row.rank}</td>
                  <td className="py-2 pr-2">
                    <button
                      type="button"
                      className="font-semibold text-zinc-100 hover:text-cyan-300"
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedMint(row.mint);
                      }}
                    >
                      {row.symbol}
                    </button>
                    <Link
                      href={`/token/${row.mint}`}
                      className="ml-1 text-[10px] text-zinc-600 hover:text-zinc-400"
                      onClick={(e) => e.stopPropagation()}
                    >
                      ↗
                    </Link>
                  </td>
                  <td className="py-2 pr-2">
                    <span
                      className={`inline-flex rounded border px-1.5 py-0.5 font-mono text-[10px] font-bold ${vis.bg} ${vis.border} ${vis.text}`}
                    >
                      {vis.short}
                    </span>
                  </td>
                  <td className={`py-2 pr-2 font-mono tracking-tight ${vis.text}`}>
                    {momentumBars(row.rank_percentile, row.rank_velocity, row.state)}
                  </td>
                  <td className="py-2 pr-2 font-mono text-zinc-200">
                    {(row.rank_percentile * 100).toFixed(0)}%
                  </td>
                  <td
                    className={`py-2 font-mono ${
                      row.rank_velocity > 0.02
                        ? "text-emerald-400"
                        : row.rank_velocity < -0.02
                          ? "text-red-400"
                          : "text-zinc-500"
                    }`}
                  >
                    {row.rank_velocity >= 0 ? "+" : ""}
                    {(row.rank_velocity * 100).toFixed(1)}%
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
