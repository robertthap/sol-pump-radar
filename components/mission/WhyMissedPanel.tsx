"use client";

import { useCallback, useEffect, useState } from "react";
import { useVisibleInterval } from "@/lib/ui/useVisibleInterval";
import { suggestedFixForMiss } from "@/lib/mission/suggested-fix";
import type { MissReportRow } from "@/lib/mission/types";
import { useMissionControl } from "@/lib/mission/MissionControlProvider";

export function WhyMissedPanel() {
  const { selectedMint } = useMissionControl();
  const [rows, setRows] = useState<MissReportRow[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const t = window.setTimeout(() => setReady(true), 18_000);
    return () => window.clearTimeout(t);
  }, []);

  const load = useCallback(async () => {
    if (!ready) return;
    try {
      const r = await fetch("/api/continuation/missed", { cache: "no-store" });
      if (!r.ok) return;
      const j = (await r.json()) as { rows: MissReportRow[] };
      const mapped = (j.rows ?? []).map((row) => ({
        ...row,
        suggestedFix: suggestedFixForMiss(row.missType),
      }));
      setRows(mapped);
      if (selectedMint) setExpanded(selectedMint);
    } catch {
      /* ignore */
    }
  }, [selectedMint, ready]);

  useVisibleInterval(load, 60_000, [load, ready]);

  const focus =
    rows.find((r) => r.mint === expanded) ??
    rows.find((r) => r.mint === selectedMint) ??
    rows.find((r) => r.gapClass !== "caught") ??
    rows[0];

  return (
    <section className="mission-panel">
      <header className="mission-panel-head">
        <h2 className="mission-title">Why missed?</h2>
        <span className="mission-sub">Forensic gaps — not guesswork</span>
      </header>
      <div className="space-y-2 px-3 pb-3">
        {focus ? (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs">
            <p className="font-mono text-[10px] text-zinc-500">MISSED WINNER REPORT</p>
            <p className="mt-1 text-sm font-bold text-zinc-100">
              {focus.symbol}{" "}
              <span className="font-normal text-zinc-500">({focus.mint.slice(0, 8)}…)</span>
            </p>
            <dl className="mt-2 space-y-1">
              <div>
                <dt className="text-zinc-500">Failure</dt>
                <dd className="font-mono text-amber-300">{focus.missType}</dd>
              </div>
              <div>
                <dt className="text-zinc-500">Stage</dt>
                <dd className="text-zinc-200">{focus.stage}</dd>
              </div>
              <div>
                <dt className="text-zinc-500">Observed</dt>
                <dd className="text-zinc-300">{focus.detail}</dd>
              </div>
              <div>
                <dt className="text-zinc-500">Suggested fix</dt>
                <dd className="text-emerald-300/90">{focus.suggestedFix}</dd>
              </div>
            </dl>
          </div>
        ) : (
          <p className="py-4 text-center text-xs text-zinc-500">
            {ready ? "No miss report rows yet." : "Miss report loads after the main dashboard…"}
          </p>
        )}
        <ul className="max-h-32 overflow-y-auto text-[10px]">
          {rows.slice(0, 8).map((r) => (
            <li key={r.mint}>
              <button
                type="button"
                className={`w-full rounded px-1 py-1 text-left hover:bg-zinc-800/50 ${
                  r.mint === focus?.mint ? "text-cyan-400" : "text-zinc-500"
                }`}
                onClick={() => setExpanded(r.mint)}
              >
                {r.symbol} · {r.missType}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
