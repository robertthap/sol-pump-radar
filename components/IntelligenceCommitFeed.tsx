"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { useVisibleInterval } from "@/lib/ui/useVisibleInterval";
import { shortAddr, relTime } from "@/lib/ui/format";
import type {
  IntelligenceCommitRow,
  IntelligenceFeedStats,
} from "@/lib/intelligence/public-types";
import {
  engineBadgeClass,
  intelligenceSignalClass,
  intelligenceSignalLabel,
  stateChipClass,
} from "@/lib/ui/intelligence-labels";

export function IntelligenceCommitFeed({ compact }: { compact?: boolean }) {
  const [commits, setCommits] = useState<IntelligenceCommitRow[]>([]);
  const [stats, setStats] = useState<IntelligenceFeedStats | null>(null);
  const [now, setNow] = useState(0);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/intelligence/feed?limit=${compact ? 20 : 50}`, {
        cache: "no-store",
      });
      if (!r.ok) return;
      const j = (await r.json()) as {
        commits: IntelligenceCommitRow[];
        stats: IntelligenceFeedStats;
      };
      setCommits(j.commits ?? []);
      setStats(j.stats ?? null);
    } catch {
      /* ignore */
    }
  }, [compact]);

  useVisibleInterval(load, compact ? 10_000 : 8_000, [load]);
  useVisibleInterval(() => setNow(Date.now()), 2_000, []);

  return (
    <div className="card p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold">Intelligence commits</h3>
          <p className="text-[10px] text-muted">
            Single authority — evaluateMintIntelligence → commit only
          </p>
        </div>
        {stats && (
          <div className="flex flex-wrap gap-1 text-[10px]">
            <span className="pill border-border">{stats.commits_last_hour}/h commits</span>
            <span className="pill border-ok/40 text-ok">{stats.auto_eligible_last_hour} auto</span>
            <span className="pill text-muted">A:{stats.engine_a_count} B:{stats.engine_b_count}</span>
          </div>
        )}
      </div>
      <div className={compact ? "max-h-52 overflow-auto" : "max-h-72 overflow-auto"}>
        <table className="w-full text-left text-[11px]">
          <thead className="sticky top-0 bg-panel text-muted">
            <tr>
              <th className="py-1 pr-2">Time</th>
              <th className="py-1 pr-2">Eng</th>
              <th className="py-1 pr-2">State</th>
              <th className="py-1 pr-2">Signal</th>
              <th className="py-1 pr-2">Rank</th>
              <th className="py-1 pr-2">Auto</th>
              <th className="py-1">Token</th>
            </tr>
          </thead>
          <tbody>
            {commits.length === 0 && (
              <tr>
                <td colSpan={7} className="py-6 text-center text-muted">
                  No intelligence commits yet — start workers with intelligence-commit enabled.
                </td>
              </tr>
            )}
            {commits.map((c) => (
              <tr key={`${c.mint}-${c.ts}`} className="border-t border-border/50">
                <td className="whitespace-nowrap py-1 pr-2 font-mono text-[10px] text-muted">
                  {now > 0 ? relTime(c.ts, now) : "…"}
                </td>
                <td className="py-1 pr-2">
                  <span className={`pill text-[9px] ${engineBadgeClass(c.engine)}`}>
                    {c.engine}
                  </span>
                </td>
                <td className={`py-1 pr-2 ${stateChipClass(c.state)}`}>{c.state}</td>
                <td className="py-1 pr-2">
                  <span className={`pill text-[9px] ${intelligenceSignalClass(c.signal)}`}>
                    {intelligenceSignalLabel(c.signal)}
                  </span>
                </td>
                <td className="py-1 pr-2 font-mono">
                  {(c.rank_percentile * 100).toFixed(0)}%
                </td>
                <td className="py-1 pr-2">
                  {c.auto_trade_allowed ? (
                    <span className="text-ok">yes</span>
                  ) : (
                    <span className="text-muted">no</span>
                  )}
                </td>
                <td className="py-1 font-mono">
                  <Link href={`/token/${c.mint}`} className="text-accent hover:underline">
                    {shortAddr(c.mint, 4, 4)}
                  </Link>
                  {c.trigger_events.length > 0 && (
                    <span className="ml-1 text-[8px] text-muted" title={c.trigger_events.join(", ")}>
                      Δ{c.trigger_events.length}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
