"use client";

import { CHART_TIMEFRAMES } from "@/lib/chart/timeframes";
import type { ChartTimeframe, PriceRegime } from "@/lib/chart/types";
import { CHART_THEME, type ChartIndicatorState } from "@/components/chart/chartTheme";
import { fmtMcap, fmtPct } from "@/components/chart/format";
import { shortAddr } from "@/lib/ui/format";

export function ChartToolbar({
  mint,
  symbol,
  regime,
  tf,
  onTf,
  live,
  logScale,
  onLogScale,
  indicators,
  onIndicators,
  onCopy,
  copied,
  onGoLive,
  atLiveEdge,
  marketCap,
  changePct,
}: {
  mint: string;
  symbol?: string | null;
  regime: PriceRegime;
  tf: ChartTimeframe;
  onTf: (tf: ChartTimeframe) => void;
  live: boolean;
  logScale: boolean;
  onLogScale: () => void;
  indicators: ChartIndicatorState;
  onIndicators: (patch: Partial<ChartIndicatorState>) => void;
  onCopy: () => void;
  copied: boolean;
  onGoLive: () => void;
  atLiveEdge: boolean;
  marketCap?: number | null;
  changePct?: number | null;
}) {
  const label = symbol?.trim() || shortAddr(mint, 4, 4);
  const chgUp = changePct != null && changePct >= 0;

  // Sub-minute frames (1s/5s/15s) only carry real per-bucket data for bonding-curve
  // tokens (built from on-chain trades). DEX tokens get OHLCV from GeckoTerminal,
  // whose finest resolution is 1 minute — so on DEX those frames would be IDENTICAL
  // to 1m. Hide them for DEX so every visible timeframe genuinely differs.
  const subMinute: ChartTimeframe[] = ["1s", "5s", "15s"];
  const timeframes =
    regime === "dex" ? CHART_TIMEFRAMES.filter((t) => !subMinute.includes(t)) : CHART_TIMEFRAMES;

  return (
    <div
      className="flex flex-col gap-1.5 border-b px-2 py-1.5"
      style={{ borderColor: CHART_THEME.border, background: CHART_THEME.panel }}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onCopy}
            className="truncate text-xs font-bold tracking-wide"
            style={{ color: CHART_THEME.textBright }}
            title={mint}
          >
            {label}
            {copied && <span className="ml-1 text-[10px] font-normal text-muted">copied</span>}
          </button>
          {marketCap != null && marketCap > 0 && (
            <span className="font-mono text-[11px] font-semibold" style={{ color: CHART_THEME.textBright }}>
              {fmtMcap(marketCap)}
            </span>
          )}
          {changePct != null && (
            <span
              className="font-mono text-[10px] font-medium"
              style={{ color: chgUp ? CHART_THEME.up : CHART_THEME.down }}
            >
              {fmtPct(changePct)}
            </span>
          )}
          <span
            className="shrink-0 rounded px-1 py-0.5 text-[9px] font-semibold uppercase"
            style={{
              background: regime === "dex" ? "rgba(59,130,246,0.15)" : "rgba(148,163,184,0.12)",
              color: regime === "dex" ? CHART_THEME.accent : CHART_THEME.text,
            }}
          >
            {regime === "dex" ? "DEX" : "Curve"}
          </span>
          <span
            className="inline-flex items-center gap-1 text-[9px]"
            style={{ color: live ? CHART_THEME.live : "#ef4444" }}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${live ? "animate-pulse" : ""}`}
              style={{ background: live ? CHART_THEME.live : "#ef4444" }}
            />
            {live ? "Live" : "Offline"}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {!atLiveEdge && (
            <button
              type="button"
              onClick={onGoLive}
              className="rounded px-1.5 py-0.5 text-[9px] font-semibold"
              style={{ background: "rgba(59,130,246,0.2)", color: CHART_THEME.accent }}
            >
              Go live
            </button>
          )}
          <button
            type="button"
            onClick={onLogScale}
            className="rounded px-1.5 py-0.5 text-[9px]"
            style={{
              background: logScale ? "rgba(59,130,246,0.2)" : "transparent",
              color: logScale ? CHART_THEME.accent : CHART_THEME.text,
            }}
          >
            Log
          </button>
          {(
            [
              ["ma7", "MA7"],
              ["ma25", "MA25"],
              ["rsi", "RSI"],
              ["volume", "Vol"],
            ] as const
          ).map(([key, lbl]) => (
            <button
              key={key}
              type="button"
              onClick={() => onIndicators({ [key]: !indicators[key] })}
              className="rounded px-1.5 py-0.5 text-[9px]"
              style={{
                background: indicators[key] ? "rgba(34,197,94,0.15)" : "transparent",
                color: indicators[key] ? CHART_THEME.up : CHART_THEME.text,
              }}
            >
              {lbl}
            </button>
          ))}
        </div>
      </div>
      <div className="flex gap-0.5 overflow-x-auto pb-0.5 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {timeframes.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => onTf(t)}
            className="shrink-0 rounded px-2 py-0.5 text-[10px] font-medium"
            style={{
              background: tf === t ? "rgba(59,130,246,0.22)" : "rgba(148,163,184,0.08)",
              color: tf === t ? CHART_THEME.accent : CHART_THEME.text,
            }}
          >
            {t}
          </button>
        ))}
      </div>
    </div>
  );
}
