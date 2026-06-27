"use client";

import { fmtMcap, fmtPct } from "@/components/chart/format";
import { CHART_THEME } from "@/components/chart/chartTheme";

export function ChartSideHud({
  status,
  liveMcap,
  entryMcapUsd,
  pnlPct,
}: {
  status?: "open" | "closed";
  liveMcap?: number | null;
  entryMcapUsd?: number | null;
  pnlPct?: number | null;
}) {
  return (
    <div
      className="flex w-full shrink-0 flex-row items-center justify-around gap-4 px-3 py-2 text-center sm:w-[96px] sm:flex-col sm:justify-center sm:gap-2 sm:px-2"
      style={{ borderColor: CHART_THEME.border, background: CHART_THEME.panel, borderLeftWidth: 1 }}
    >
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
