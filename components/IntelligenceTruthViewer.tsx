"use client";

import { useCallback, useEffect, useState } from "react";
import { useVisibleInterval } from "@/lib/ui/useVisibleInterval";
import { EVAL_MINTS_PUBLIC } from "@/lib/continuation/eval-mints-public";
import type { IntelligenceCommitRow } from "@/lib/intelligence/public-types";
import {
  engineBadgeClass,
  intelligenceSignalClass,
  intelligenceSignalLabel,
  stateChipClass,
} from "@/lib/ui/intelligence-labels";

const EVAL_OPTIONS = EVAL_MINTS_PUBLIC;

type Trace = {
  timestamp: number;
  inputs: { state: string; rankPercentile: number; rankVelocity: number };
  outputs: { score: number; action: string };
  finalReason: string;
  stage?: string;
};

type MissRow = {
  mint: string;
  symbol: string;
  missType: string;
  stage: string;
  detail: string;
};

export function IntelligenceTruthViewer({
  defaultMint,
  compact = false,
}: {
  defaultMint?: string;
  compact?: boolean;
} = {}) {
  const [mint, setMint] = useState(defaultMint ?? EVAL_OPTIONS[0]?.mint ?? "");
  const [traces, setTraces] = useState<Trace[]>([]);
  const [commits, setCommits] = useState<IntelligenceCommitRow[]>([]);
  const [miss, setMiss] = useState<MissRow | null>(null);
  const [replaySteps, setReplaySteps] = useState<
    Array<{ ts: number; state: string; rankPercentile: number; action: string }>
  >([]);

  const load = useCallback(async () => {
    if (!mint) return;
    try {
      const [t, m, rp, feed] = await Promise.all([
        fetch(`/api/continuation/trace?mint=${mint}`, { cache: "no-store" }),
        fetch("/api/continuation/missed", { cache: "no-store" }),
        fetch(`/api/continuation/replay?mint=${mint}&hours=24`, { cache: "no-store" }),
        fetch(`/api/intelligence/feed?mint=${mint}&limit=20`, { cache: "no-store" }),
      ]);
      if (t.ok) {
        const j = (await t.json()) as { traces: Trace[] };
        setTraces(j.traces ?? []);
      }
      if (feed.ok) {
        const j = (await feed.json()) as { commits: IntelligenceCommitRow[] };
        setCommits(j.commits ?? []);
      }
      if (m.ok) {
        const j = (await m.json()) as { rows: MissRow[] };
        setMiss(j.rows?.find((r) => r.mint === mint) ?? null);
      }
      if (rp.ok) {
        const j = (await rp.json()) as {
          mints: Array<{ mint: string; steps: typeof replaySteps }>;
        };
        setReplaySteps(j.mints?.[0]?.steps ?? []);
      }
    } catch {
      /* ignore */
    }
  }, [mint]);

  useEffect(() => {
    if (defaultMint) setMint(defaultMint);
  }, [defaultMint]);

  useEffect(() => {
    void load();
  }, [load]);

  useVisibleInterval(load, 12_000, [load]);

  const commitTraces = traces.filter((t) => t.stage === "intelligence_commit");
  const engineTraces = traces.filter(
    (t) => !t.stage || t.stage.includes("engine") || t.stage.includes("intelligence"),
  );

  return (
    <div className={compact ? "p-1" : "card p-3"}>
      {!compact && (
        <>
          <h3 className="mb-1 text-sm font-semibold">Intelligence truth</h3>
          <p className="mb-2 text-[10px] text-muted">
            Fused A+B commits, traces, and replay steps for one mint.
          </p>
          <div className="mb-2 flex flex-wrap gap-2">
            <select
              className="rounded border border-border bg-panel px-2 py-1 text-xs"
              value={mint}
              onChange={(e) => setMint(e.target.value)}
            >
              {EVAL_OPTIONS.map((o) => (
                <option key={o.mint} value={o.mint}>
                  {o.symbol}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="rounded border border-border px-2 py-1 text-xs hover:bg-panel"
              onClick={() => void load()}
            >
              Load
            </button>
          </div>
        </>
      )}

      {commits[0] && (
        <div className="mb-2 rounded border border-accent/30 bg-accent/5 px-2 py-1.5 text-[10px]">
          <span className={`pill mr-1 ${engineBadgeClass(commits[0].engine)}`}>
            Engine {commits[0].engine}
          </span>
          <span className={`pill mr-1 ${intelligenceSignalClass(commits[0].signal)}`}>
            {intelligenceSignalLabel(commits[0].signal)}
          </span>
          <span className={`mr-2 ${stateChipClass(commits[0].state)}`}>{commits[0].state}</span>
          <span className="font-mono">rank {(commits[0].rank_percentile * 100).toFixed(0)}%</span>
          <span className="ml-2">
            auto {commits[0].auto_trade_allowed ? "yes" : "no"}
          </span>
          {commits[0].miss_type && (
            <span className="ml-2 text-warn">miss {commits[0].miss_type}</span>
          )}
          <div className="mt-1 truncate text-muted">{commits[0].reason}</div>
        </div>
      )}

      {miss && miss.missType !== "NONE" && (
        <p className="mb-2 rounded border border-warn/40 bg-warn/10 px-2 py-1 text-xs text-warn">
          Miss: {miss.missType} — {miss.detail} ({miss.stage})
        </p>
      )}

      {replaySteps.length > 0 && (
        <p className="mb-2 text-[10px] text-muted">
          Replay: {replaySteps.length} steps · last {replaySteps[replaySteps.length - 1]?.state}
        </p>
      )}

      <div className="max-h-40 overflow-y-auto text-[10px] font-mono">
        <p className="mb-1 text-[9px] uppercase text-muted">Intelligence commits</p>
        {commits.slice(0, 8).map((c, i) => (
          <div key={i} className="border-t border-border/40 py-1">
            {new Date(c.ts).toLocaleTimeString()} · {c.signal} · {c.state} · auto{" "}
            {c.auto_trade_allowed ? "Y" : "N"}
          </div>
        ))}
        {!commits.length && <p className="text-muted">No commits for this mint yet</p>}
      </div>

      <div className="mt-2 max-h-36 overflow-y-auto text-[10px] font-mono">
        <p className="mb-1 text-[9px] uppercase text-muted">Traces</p>
        {(commitTraces.length ? commitTraces : engineTraces).slice(-10).map((tr, i) => (
          <div key={i} className="border-t border-border/40 py-1">
            {new Date(tr.timestamp).toLocaleTimeString()} · {tr.outputs.action} ·{" "}
            {(tr.inputs.rankPercentile * 100).toFixed(0)}%
            <div className="truncate text-muted">{tr.finalReason}</div>
          </div>
        ))}
        {!traces.length && <p className="text-muted">No traces — run workers</p>}
      </div>
    </div>
  );
}
