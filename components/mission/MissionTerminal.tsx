"use client";

import { ScrollText } from "lucide-react";
import { useMissionControl } from "@/lib/mission/MissionControlProvider";
import { relTime } from "@/lib/ui/format";

export function MissionTerminal() {
  const { data } = useMissionControl();
  const commits = data?.recentCommits ?? [];
  const ticks = data?.workerLastTickMs ?? {};

  return (
    <footer className="border-t border-zinc-800 bg-black/80">
      <div className="flex items-center gap-2 border-b border-zinc-800/80 px-3 py-1.5 text-[10px] text-zinc-500">
        <ScrollText className="h-3.5 w-3.5" />
        Decision terminal
        <span className="ml-auto font-mono">
          intel-commit {ticks["intelligence-commit"] ?? "—"}ms · universe{" "}
          {ticks["continuation-universe"] ?? "—"}ms
        </span>
      </div>
      <div className="mission-log max-h-28 overflow-y-auto px-3 py-2 font-mono text-[10px] leading-relaxed text-zinc-400">
        {commits.slice(0, 12).map((c, i) => {
          const ts = c.ts instanceof Date ? c.ts.getTime() : new Date(c.ts).getTime();
          return (
            <div key={`${c.mint}-${ts}-${i}`} className="text-zinc-500">
              <span className="text-zinc-600">[{relTime(ts)}]</span>{" "}
              <span className="text-cyan-500">{c.symbol}</span>{" "}
              <span className="text-zinc-300">{c.signal ?? "—"}</span> · {c.state} · rank{" "}
              {c.rank_percentile != null ? `${(c.rank_percentile * 100).toFixed(0)}%` : "—"} ·{" "}
              <span className="text-zinc-600">{c.reason?.slice(0, 72)}</span>
            </div>
          );
        })}
        {!commits.length && <p>Waiting for intelligence commits…</p>}
      </div>
    </footer>
  );
}
