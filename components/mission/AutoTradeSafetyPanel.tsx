"use client";

import { useCallback, useState } from "react";
import { useVisibleInterval } from "@/lib/ui/useVisibleInterval";
import {
  engineBadgeClass,
  intelligenceSignalClass,
  intelligenceSignalLabel,
  stateChipClass,
} from "@/lib/ui/intelligence-labels";
import type { IntelligenceCommitRow } from "@/lib/intelligence/public-types";

type AutoStatus = {
  active: boolean;
  cbState: string;
  session: { params: { sizeSol: number; signalStrictness: string } } | null;
};

export function AutoTradeSafetyPanel() {
  const [status, setStatus] = useState<AutoStatus | null>(null);
  const [eligible, setEligible] = useState<IntelligenceCommitRow[]>([]);

  const load = useCallback(async () => {
    try {
      const a = await fetch("/api/auto/status", { cache: "no-store" });
      if (a.ok) setStatus((await a.json()) as AutoStatus);
    } catch {
      /* ignore */
    }
  }, []);

  const loadEligible = useCallback(async () => {
    try {
      const s = await fetch("/api/intelligence/feed?limit=12", { cache: "no-store" });
      if (!s.ok) return;
      const j = (await s.json()) as { commits: IntelligenceCommitRow[] };
      setEligible((j.commits ?? []).filter((c) => c.auto_trade_allowed));
    } catch {
      /* ignore */
    }
  }, []);

  useVisibleInterval(load, 10_000, [load]);
  useVisibleInterval(loadEligible, 20_000, [loadEligible]);

  return (
    <section className="mission-panel">
      <header className="mission-panel-head">
        <h2 className="mission-title">Auto-trade safety</h2>
        <span className="mission-sub">Execution gate transparency</span>
      </header>
      <div className="grid gap-2 px-3 pb-3 sm:grid-cols-2">
        <dl className="rounded border border-zinc-800 bg-zinc-900/50 p-2 text-[10px]">
          <div className="flex justify-between">
            <dt className="text-zinc-500">Session</dt>
            <dd className={status?.active ? "text-emerald-400" : "text-zinc-400"}>
              {status?.active ? "ACTIVE" : "OFF"}
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-zinc-500">Circuit breaker</dt>
            <dd className="font-mono text-zinc-200">{status?.cbState ?? "—"}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-zinc-500">Risk mode</dt>
            <dd className="text-zinc-200">{status?.session?.params.signalStrictness ?? "—"}</dd>
          </div>
        </dl>
        <p className="text-[10px] leading-relaxed text-zinc-500">
          Only intelligence-commit rows with <code className="text-cyan-500">auto_trade_allowed</code>{" "}
          may open positions. Extension risk blocked in parabolic / exhaustion.
        </p>
      </div>
      <div className="grid gap-2 px-3 pb-3 sm:grid-cols-2">
        {eligible.length === 0 ? (
          <p className="col-span-2 py-2 text-center text-xs text-zinc-500">No auto-eligible signals right now.</p>
        ) : (
          eligible.slice(0, 4).map((c) => (
            <article
              key={`${c.mint}-${c.ts}`}
              className="rounded-lg border border-emerald-500/25 bg-emerald-500/5 p-2.5"
            >
              <p className={`text-sm font-bold ${intelligenceSignalClass(c.signal)}`}>
                {intelligenceSignalLabel(c.signal)}
              </p>
              <p className="mt-1 font-mono text-[10px] text-zinc-400">{c.mint.slice(0, 12)}…</p>
              <ul className="mt-2 space-y-0.5 text-[10px] text-zinc-400">
                <li>
                  Engine{" "}
                  <span className={engineBadgeClass(c.engine)}>{c.engine}</span>
                </li>
                <li className={stateChipClass(c.state)}>STATE: {c.state}</li>
                <li>RANK: {(c.rank_percentile * 100).toFixed(0)}%</li>
                <li>CONF: {c.confidence.toFixed(2)}</li>
                <li className="text-emerald-400/80">AUTO: ENABLED</li>
                <li className="text-zinc-500">REASON: {c.reason.slice(0, 80)}</li>
              </ul>
            </article>
          ))
        )}
      </div>
    </section>
  );
}
