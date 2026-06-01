"use client";
import { shortAddr } from "@/lib/ui/format";
import { tierClass } from "@/lib/signals/quality";

export type HotSignal = {
  mint: string;
  symbol: string | null;
  action: string;
  qualityScore: number;
  qualityTier: "hot" | "good" | "fair" | "weak" | "avoid";
  confluenceScore: number;
  changePct: number | null;
  smartMoneyCount: number;
};

export function TerminalHotSignals({
  signals,
  activeMint,
  onPick,
}: {
  signals: HotSignal[];
  activeMint: string | null;
  onPick: (mint: string) => void;
}) {
  if (signals.length === 0) return null;

  return (
    <div className="terminal-hot-strip mb-2 flex flex-wrap items-center gap-1.5">
      <span className="text-[10px] font-medium uppercase tracking-wide text-muted">Tradable</span>
      {signals.map((s) => (
        <button
          key={s.mint}
          type="button"
          onClick={() => onPick(s.mint)}
          className={`terminal-hot-chip rounded border px-2 py-1 text-left text-[10px] transition-colors ${
            activeMint === s.mint
              ? "border-accent bg-accent/15"
              : "border-border/60 bg-panel/80 hover:border-accent/50"
          }`}
        >
          <span className="font-medium text-fg">{s.symbol ?? shortAddr(s.mint, 3, 3)}</span>
          <span className={`ml-1.5 pill font-mono text-[9px] ${tierClass(s.qualityTier)}`}>
            {s.qualityScore}
          </span>
          {s.changePct != null && (
            <span
              className={`ml-1 font-mono text-[9px] ${
                s.changePct >= 0 ? "text-ok" : "text-bad"
              }`}
            >
              {s.changePct >= 0 ? "+" : ""}
              {s.changePct.toFixed(0)}%
            </span>
          )}
          {s.smartMoneyCount > 0 && (
            <span className="ml-1 text-[8px] text-accent">{s.smartMoneyCount}SM</span>
          )}
        </button>
      ))}
    </div>
  );
}
