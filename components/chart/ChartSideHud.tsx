"use client";

import { fmtMcap, fmtPct } from "@/components/chart/chartStore";

/** Side HUD — preserved from TradeMarkerChart (live/exit mcap, entry, PnL). */
export function ChartSideHud({
  liveMcap,
  entryMcapUsd,
  pnlPct,
  status,
}: {
  liveMcap?: number | null;
  entryMcapUsd?: number | null;
  pnlPct?: number | null;
  status?: "open" | "closed";
}) {
  return (
    <div className="flex w-full shrink-0 flex-row items-center justify-around gap-4 border-t border-border/50 px-3 py-2 text-center sm:w-[92px] sm:flex-col sm:justify-center sm:gap-2 sm:border-l sm:border-t-0 sm:px-2">
      <div>
        <p className="text-[9px] uppercase tracking-wide text-muted">
          {status === "closed" ? "Exit mcap" : "Live mcap"}
        </p>
        <p className="font-mono text-sm font-semibold text-fg">{fmtMcap(liveMcap)}</p>
        {status !== "closed" && liveMcap != null && (
          <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-ok" aria-hidden />
        )}
      </div>
      <div>
        <p className="text-[9px] uppercase tracking-wide text-muted">Entry</p>
        <p className="font-mono text-xs">{fmtMcap(entryMcapUsd)}</p>
      </div>
      {pnlPct != null && (
        <div>
          <p className="text-[9px] uppercase tracking-wide text-muted">PnL</p>
          <p className={`font-mono text-xs ${pnlPct >= 0 ? "text-ok" : "text-bad"}`}>{fmtPct(pnlPct)}</p>
        </div>
      )}
    </div>
  );
}
