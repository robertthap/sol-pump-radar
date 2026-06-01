"use client";

import { useCallback, useState } from "react";
import { useVisibleInterval } from "@/lib/ui/useVisibleInterval";
import { shortAddr } from "@/lib/ui/format";
import { stateChipClass } from "@/lib/ui/intelligence-labels";

type Candidate = {
  mint: string;
  continuation_score: number;
  alert_action: string | null;
  dex_h24_pct: number | null;
  liq_usd: number;
  trend_rank: number;
  symbol: string | null;
  momentum_state?: string | null;
  rank_percentile?: number | null;
  rank_velocity?: number | null;
  engine_b_action?: string | null;
  p_breakout?: number | null;
  p_exhaustion?: number | null;
};

type IntelligenceStats = {
  commits_last_hour: number;
  auto_eligible_last_hour: number;
  engine_a_count?: number;
  engine_b_count?: number;
};

export function ContinuationPanel({ compact }: { compact?: boolean }) {
  const [stats, setStats] = useState<{ total: number; alert_ready: number } | null>(null);
  const [intelStats, setIntelStats] = useState<IntelligenceStats | null>(null);
  const [rows, setRows] = useState<Candidate[]>([]);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/continuation/status", { cache: "no-store" });
      if (r.ok) {
        const j = (await r.json()) as {
          stats: { total: number; alert_ready: number };
          intelligence?: IntelligenceStats;
          topCandidates: Candidate[];
        };
        setStats(j.stats);
        setRows(j.topCandidates ?? []);
        if (j.intelligence) setIntelStats(j.intelligence);
      }
    } catch {
      /* ignore */
    }
  }, []);

  useVisibleInterval(load, compact ? 12_000 : 8_000, [load]);

  return (
    <div className="card p-3">
      <div className="mb-2 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold">Engine B universe</h3>
          <p className="text-[10px] text-muted">Feeder only — signals from intelligence-commit</p>
        </div>
        <span className="text-[10px] text-muted">
          {stats ? `${stats.total} active` : "…"}
          {intelStats
            ? ` · ${intelStats.commits_last_hour}/h intel · ${intelStats.auto_eligible_last_hour} auto`
            : ""}
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-[11px]">
          <thead className="text-muted">
            <tr>
              <th className="py-1 pr-2">#</th>
              <th className="py-1 pr-2">Token</th>
              <th className="py-1 pr-2">State</th>
              <th className="py-1 pr-2">Rank%</th>
              <th className="py-1 pr-2">Vel</th>
              <th className="py-1">Score</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.mint} className="border-t border-border/60">
                <td className="py-1 pr-2 text-muted">{r.trend_rank}</td>
                <td className="py-1 pr-2 font-mono">{r.symbol ?? shortAddr(r.mint)}</td>
                <td className={`py-1 pr-2 ${stateChipClass(r.momentum_state ?? "cold")}`}>
                  {r.momentum_state ?? "—"}
                </td>
                <td className="py-1 pr-2">
                  {r.rank_percentile != null ? `${(r.rank_percentile * 100).toFixed(0)}%` : "—"}
                </td>
                <td className="py-1 pr-2">
                  {r.rank_velocity != null ? r.rank_velocity.toFixed(2) : "—"}
                </td>
                <td className="py-1">{r.continuation_score?.toFixed(2) ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
