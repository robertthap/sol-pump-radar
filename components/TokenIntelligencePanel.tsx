"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { useVisibleInterval } from "@/lib/ui/useVisibleInterval";
import { relTime } from "@/lib/ui/format";
import type {
  IntelligenceCommitRow,
  IntelligencePreviewOutput,
} from "@/lib/intelligence/public-types";
import {
  engineBadgeClass,
  intelligenceSignalClass,
  intelligenceSignalLabel,
  stateChipClass,
} from "@/lib/ui/intelligence-labels";

type PreviewPayload = {
  in_universe: boolean;
  output: IntelligencePreviewOutput | null;
  fusion: { engine: string; reason: string } | null;
  error?: string;
};

type TraceRow = {
  timestamp: number;
  stage?: string;
  outputs: { action: string; score: number };
  finalReason: string;
};

export function TokenIntelligencePanel({ mint }: { mint: string }) {
  const [commits, setCommits] = useState<IntelligenceCommitRow[]>([]);
  const [preview, setPreview] = useState<PreviewPayload | null>(null);
  const [traces, setTraces] = useState<TraceRow[]>([]);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [now, setNow] = useState(0);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/intelligence/token-bundle?mint=${encodeURIComponent(mint)}&preview=0`, {
        cache: "no-store",
      });
      if (!r.ok) return;
      const j = (await r.json()) as {
        commits: IntelligenceCommitRow[];
        traces: TraceRow[];
        preview: PreviewPayload | null;
      };
      setCommits(j.commits ?? []);
      setTraces((j.traces ?? []).slice(0, 12));
      if (j.preview) setPreview(j.preview);
    } catch {
      /* ignore */
    }
  }, [mint]);

  const loadPreview = useCallback(async () => {
    setPreviewLoading(true);
    try {
      await load();
    } finally {
      setPreviewLoading(false);
    }
  }, [load]);

  useVisibleInterval(load, 8_000, [load]);
  useVisibleInterval(() => setNow(Date.now()), 2_000, []);

  const latest = commits[0];
  const live = preview?.output;

  return (
    <div className="card p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold">Intelligence</h3>
          <p className="text-[10px] text-muted">
            Committed signals only — intelligence-commit is the sole authority
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            className="rounded border border-border px-2 py-1 text-[10px] hover:bg-panel"
            disabled={previewLoading}
            onClick={() => void loadPreview()}
          >
            {previewLoading ? "…" : "Live preview"}
          </button>
          <Link href="/signals" className="rounded border border-border px-2 py-1 text-[10px] hover:bg-panel">
            All signals
          </Link>
        </div>
      </div>

      {live && (
        <div className="mb-2 rounded border border-accent/30 bg-accent/5 px-2 py-1.5 text-[10px]">
          <span className="mr-1 text-[9px] uppercase text-muted">Preview (not committed)</span>
          <span className={`pill mr-1 ${engineBadgeClass(live.engine)}`}>Eng {live.engine}</span>
          <span className={`pill mr-1 ${intelligenceSignalClass(live.signal)}`}>
            {intelligenceSignalLabel(live.signal)}
          </span>
          <span className={`mr-2 ${stateChipClass(live.state)}`}>{live.state}</span>
          <span className="font-mono">{(live.rank_percentile * 100).toFixed(0)}%</span>
          <span className="ml-2">{live.auto_trade_allowed ? "auto yes" : "auto no"}</span>
          {preview?.fusion && (
            <div className="mt-1 truncate text-muted">{preview.fusion.reason}</div>
          )}
        </div>
      )}

      {preview && preview.in_universe === false && !live && (
        <p className="mb-2 rounded border border-warn/40 bg-warn/10 px-2 py-1 text-[10px] text-warn">
          Not in commit universe (NOT_IN_UNIVERSE) — waiting for Dex continuation row or analytics
          snapshot. Launch hot alone does not add a full row until scored.
        </p>
      )}

      {latest ? (
        <div className="mb-2 rounded border border-border/60 px-2 py-1.5 text-[10px]">
          <span className="text-[9px] uppercase text-muted">Latest commit</span>
          <div className="mt-1 flex flex-wrap items-center gap-1">
            <span className={`pill ${engineBadgeClass(latest.engine)}`}>{latest.engine}</span>
            <span className={`pill ${intelligenceSignalClass(latest.signal)}`}>
              {intelligenceSignalLabel(latest.signal)}
            </span>
            <span className={stateChipClass(latest.state)}>{latest.state}</span>
            <span className="font-mono">{(latest.rank_percentile * 100).toFixed(0)}%</span>
            <span className={latest.auto_trade_allowed ? "text-ok" : "text-muted"}>
              auto {latest.auto_trade_allowed ? "yes" : "no"}
            </span>
            {now > 0 && (
              <span className="text-muted">{relTime(latest.ts, now)}</span>
            )}
          </div>
          <p className="mt-1 truncate text-muted">{latest.reason}</p>
        </div>
      ) : (
        <p className="mb-2 text-[10px] text-muted">No commits for this mint yet.</p>
      )}

      <div className="max-h-28 overflow-y-auto text-[10px] font-mono">
        <p className="mb-1 text-[9px] uppercase text-muted">Recent commits</p>
        {commits.slice(0, 6).map((c) => (
          <div key={c.ts} className="border-t border-border/40 py-0.5">
            {now > 0 ? relTime(c.ts, now) : "…"} · {c.signal} · {c.state}
          </div>
        ))}
      </div>

      {traces.length > 0 && (
        <div className="mt-2 max-h-24 overflow-y-auto text-[10px] font-mono">
          <p className="mb-1 text-[9px] uppercase text-muted">Traces</p>
          {traces.slice(0, 5).map((t, i) => (
            <div key={i} className="border-t border-border/40 py-0.5 truncate">
              {t.stage ?? "trace"} · {t.outputs.action}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
