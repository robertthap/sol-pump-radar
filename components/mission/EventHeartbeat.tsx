"use client";

import { useMissionControl } from "@/lib/mission/MissionControlProvider";
import { relTime } from "@/lib/ui/format";

function formatEvent(kind: string, payload: unknown): string {
  const p = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const detail = typeof p.detail === "string" ? p.detail : typeof p.pct === "number" ? `${p.pct}%` : "";
  const k = kind.replace(/_/g, " ").toUpperCase();
  return detail ? `${k} ${detail}` : k;
}

export function EventHeartbeat() {
  const { data, setSelectedMint } = useMissionControl();
  const events = data?.events ?? [];
  const commits = data?.recentCommits ?? [];

  const lines: Array<{ ts: number; mint: string; symbol: string; text: string }> = [];

  for (const e of events.slice(0, 20)) {
    const ts = e.ts instanceof Date ? e.ts.getTime() : new Date(e.ts).getTime();
    const sym = e.mint.slice(0, 6);
    lines.push({ ts, mint: e.mint, symbol: sym, text: formatEvent(e.kind, e.payload) });
  }

  for (let i = 1; i < Math.min(commits.length, 15); i++) {
    const cur = commits[i - 1];
    const prev = commits[i];
    if (cur.mint === prev.mint && cur.state && prev.state && cur.state !== prev.state) {
      const ts = cur.ts instanceof Date ? cur.ts.getTime() : new Date(cur.ts).getTime();
      lines.push({
        ts,
        mint: cur.mint,
        symbol: cur.symbol,
        text: `${prev.state?.toUpperCase()} → ${cur.state?.toUpperCase()}`,
      });
    }
  }

  lines.sort((a, b) => b.ts - a.ts);

  return (
    <section className="mission-panel flex max-h-[280px] flex-col">
      <header className="mission-panel-head shrink-0">
        <h2 className="mission-title">Market heartbeat</h2>
        <span className="mission-sub">Triggers + state transitions</span>
      </header>
      <ul className="mission-log flex-1 overflow-y-auto px-2 pb-2 font-mono text-[11px]">
        {lines.length === 0 ? (
          <li className="py-4 text-center text-zinc-500">Waiting for events…</li>
        ) : (
          lines.slice(0, 24).map((line, i) => (
            <li key={`${line.mint}-${line.ts}-${i}`} className="border-b border-zinc-800/60 py-1.5">
              <button
                type="button"
                className="w-full text-left hover:bg-zinc-800/30"
                onClick={() => setSelectedMint(line.mint)}
              >
                <span className="text-zinc-600">[{relTime(line.ts)}]</span>{" "}
                <span className="text-cyan-400">{line.symbol}</span>{" "}
                <span className="text-zinc-300">→ {line.text}</span>
              </button>
            </li>
          ))
        )}
      </ul>
    </section>
  );
}
