"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ChartTimeframe, UserTrade, ChartMarkerInstance } from "@/lib/chart/types";
import { ChartSideHud } from "@/components/chart/ChartSideHud";
import { useChartMint, fmtMcap, fmtPct } from "@/components/chart/chartStore";
import { useChartStream } from "@/components/chart/useChartStream";
import {
  useCandleChart,
  applyCandlesToSeries,
  applyMarkers,
  fetchCandlePage,
  useScrollBackLoader,
  useLiveEdgeTracking,
  scrollChartToTime,
  type CandleChartHandle,
} from "@/components/chart/CandleSeries";
import { markersToLwCharts, findMarkerAtCrosshair } from "@/lib/chart/engine/markerEngine";
import { shortAddr } from "@/lib/ui/format";

const TFS: ChartTimeframe[] = ["1s", "5s", "1m"];

export function TradingChart({
  mint,
  height = 260,
  entryMcapUsd,
  pnlPct,
  status,
  userTrades,
  showSideHud = true,
  scrollToBuy = false,
}: {
  mint: string;
  height?: number;
  entryMcapUsd?: number | null;
  pnlPct?: number | null;
  status?: "open" | "closed";
  userTrades?: UserTrade[];
  showSideHud?: boolean;
  scrollToBuy?: boolean;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const candleMetaRef = useRef({ len: 0, lastTime: 0 });
  const [handle, setHandle] = useState<CandleChartHandle | null>(null);
  const [copied, setCopied] = useState(false);
  const [hover, setHover] = useState<
    | { kind: "candle"; price: number; t: number }
    | { kind: "marker"; marker: ChartMarkerInstance; t: number }
    | null
  >(null);

  const chart = useChartMint(mint);
  const {
    tf,
    setTf,
    resetMint,
    historicalCandles: candles,
    marketCap,
    markersById,
    oldestTradeId,
    loading,
    regime,
    wsConnected,
    setHistorical,
    prependHistorical,
    setAtLiveEdge,
    setUserTrades,
    applySnapshot,
  } = chart;

  const onReady = useCallback((h: CandleChartHandle) => setHandle(h), []);

  useCandleChart(wrapRef, height, onReady);
  useChartStream(mint, tf);

  useEffect(() => {
    resetMint();
    candleMetaRef.current = { len: 0, lastTime: 0 };
  }, [mint, resetMint]);

  useEffect(() => {
    if (userTrades) setUserTrades(userTrades);
  }, [userTrades, setUserTrades]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [page, state] = await Promise.all([
          fetchCandlePage(mint, tf),
          fetch(`/api/tokens/${encodeURIComponent(mint)}/chart-state?tf=${tf}`, {
            cache: "no-store",
          }).then((r) => (r.ok ? r.json() : null)),
        ]);
        if (!alive) return;
        setHistorical(page.candles, page.oldestTradeId);
        if (state?.lastTradeId != null) {
          applySnapshot({
            candles: state.candles ?? [],
            marketCap: state.marketCap ?? 0,
            epoch: state.epoch ?? 1,
            lastTradeId: state.lastTradeId,
            regime: state.regime,
          });
        }
      } catch {
        if (alive) setHistorical([], null);
      }
    })();
    return () => {
      alive = false;
    };
  }, [mint, tf, setHistorical, applySnapshot]);

  useEffect(() => {
    if (!handle || !candles.length) return;
    const last = candles[candles.length - 1]!;
    const prev = candleMetaRef.current;
    const sameLen = candles.length === prev.len;
    const sameLastTime = last.time === prev.lastTime;
    const appendedOne = candles.length === prev.len + 1;
    const useUpdate =
      prev.len > 0 && ((sameLen && sameLastTime) || (appendedOne && !sameLastTime));
    applyCandlesToSeries(handle, candles, useUpdate ? "update" : "set");
    applyMarkers(handle, markersToLwCharts(markersById));
    candleMetaRef.current = { len: candles.length, lastTime: last.time };
  }, [handle, candles, markersById]);

  useScrollBackLoader({
    mint,
    tf,
    handle,
    oldestTradeId,
    onPrepend: prependHistorical,
  });

  useLiveEdgeTracking(handle, mint, candles.length, setAtLiveEdge);

  useEffect(() => {
    if (!scrollToBuy || !handle || !userTrades?.length || !candles.length) return;
    const buy = userTrades.find((t) => t.side === "buy");
    if (!buy) return;
    scrollChartToTime(handle, candles, Math.floor(buy.timestamp / 1000));
  }, [scrollToBuy, handle, userTrades, candles]);

  useEffect(() => {
    if (!handle) return;
    return handle.chart.subscribeCrosshairMove((param) => {
      if (!param.time || !param.seriesData.size) {
        setHover(null);
        return;
      }
      const t = param.time as number;
      const marker = findMarkerAtCrosshair(markersById, t, tf);
      if (marker) {
        setHover({ kind: "marker", marker, t });
        return;
      }
      const d = param.seriesData.get(handle.candleSeries);
      if (!d || !("close" in d)) {
        setHover(null);
        return;
      }
      setHover({ kind: "candle", price: d.close as number, t });
    });
  }, [handle, markersById, tf]);

  const liveMcap = marketCap > 0 ? marketCap : entryMcapUsd;

  return (
    <div className="overflow-hidden rounded-lg border border-border/60 bg-panel/20">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/50 px-2 py-1.5 text-[10px]">
        <button
          type="button"
          className="font-mono text-muted hover:text-fg"
          onClick={() => {
            void navigator.clipboard.writeText(mint);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
        >
          {copied ? "Copied" : shortAddr(mint, 6, 6)}
        </button>
        <div className="flex items-center gap-1">
          <span
            className={`rounded px-1 py-0.5 text-[9px] uppercase tracking-wide ${
              regime === "dex" ? "bg-accent/15 text-accent" : "bg-muted/20 text-muted"
            }`}
            title={regime === "dex" ? "DEX pricing" : "Bonding curve pricing"}
          >
            {regime === "dex" ? "DEX" : "Curve"}
          </span>
          {TFS.map((t) => (
            <button
              key={t}
              type="button"
              className={`rounded px-1.5 py-0.5 ${tf === t ? "bg-accent/20 text-accent" : "text-muted hover:text-fg"}`}
              onClick={() => setTf(t)}
            >
              {t}
            </button>
          ))}
        </div>
        <a
          href={`https://dexscreener.com/solana/${encodeURIComponent(mint)}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-accent hover:underline"
        >
          DexScreener ↗
        </a>
        {!wsConnected && !loading && (
          <span className="text-[9px] text-bad" title="Start pnpm worker for live updates">
            Live off
          </span>
        )}
      </div>

      <div className="flex flex-col sm:flex-row">
        <div
          ref={wrapRef}
          style={{ height: `${height}px` }}
          className="relative min-h-0 w-full flex-1 overflow-hidden"
        >
          {loading && (
            <div className="absolute inset-0 z-10 flex items-center justify-center text-xs text-muted">
              Loading chart…
            </div>
          )}
          {hover && (
            <div className="pointer-events-none absolute left-2 top-2 z-10 rounded border border-border/70 bg-panel/95 px-1.5 py-1 text-[10px] shadow">
              {hover.kind === "marker" ? (
                <>
                  <div
                    className={`font-semibold ${hover.marker.side === "buy" ? "text-ok" : "text-bad"}`}
                  >
                    {hover.marker.side === "buy" ? "Buy" : "Sell"}
                    {hover.marker.amount > 0
                      ? ` · ${hover.marker.amount.toFixed(3)} SOL`
                      : ""}
                  </div>
                  <div className="font-mono font-semibold text-fg">
                    {fmtMcap(hover.marker.price * 1e9)}
                  </div>
                  {hover.marker.pnl != null && (
                    <div
                      className={`font-mono ${hover.marker.pnl >= 0 ? "text-ok" : "text-bad"}`}
                    >
                      PnL {fmtPct(hover.marker.pnl)}
                    </div>
                  )}
                </>
              ) : (
                <>
                  <div className="font-mono font-semibold text-fg">{fmtMcap(hover.price * 1e9)}</div>
                  <div className="text-muted">
                    {new Date(hover.t * 1000).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                      second: "2-digit",
                    })}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
        {showSideHud && (
          <ChartSideHud
            liveMcap={liveMcap}
            entryMcapUsd={entryMcapUsd}
            pnlPct={pnlPct}
            status={status}
          />
        )}
      </div>
    </div>
  );
}
