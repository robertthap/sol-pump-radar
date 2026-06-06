"use client";

import { useEffect, useRef } from "react";
import {
  createChart,
  CandlestickSeries,
  HistogramSeries,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import type { Candle, ChartTimeframe } from "@/lib/chart/types";
import { CANDLE_PAGE_SIZE, SCROLL_DEBOUNCE_MS, SCROLL_PREFETCH_BARS } from "@/lib/chart/constants";
import { markersToLwCharts } from "@/lib/chart/engine/markerEngine";

export type CandleChartHandle = {
  chart: IChartApi;
  candleSeries: ISeriesApi<"Candlestick">;
  volumeSeries: ISeriesApi<"Histogram">;
};

export function toLwCandle(c: Candle) {
  return {
    time: c.time as UTCTimestamp,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
  };
}

export function toLwVolume(c: Candle) {
  return {
    time: c.time as UTCTimestamp,
    value: c.volume,
    color: c.close >= c.open ? "rgba(34,197,94,0.45)" : "rgba(239,68,68,0.45)",
  };
}

export function useCandleChart(
  containerRef: React.RefObject<HTMLDivElement | null>,
  height: number,
  onReady?: (h: CandleChartHandle) => void,
) {
  const handleRef = useRef<CandleChartHandle | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const chart = createChart(el, {
      height,
      layout: {
        background: { color: "transparent" },
        textColor: "#94a3b8",
      },
      grid: {
        vertLines: { color: "rgba(148,163,184,0.08)" },
        horzLines: { color: "rgba(148,163,184,0.08)" },
      },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: true },
      crosshair: { mode: 1 },
    });

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: "#22c55e",
      downColor: "#ef4444",
      borderVisible: false,
      wickUpColor: "#22c55e",
      wickDownColor: "#ef4444",
    });

    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "vol",
    });
    chart.priceScale("vol").applyOptions({
      scaleMargins: { top: 0.82, bottom: 0 },
    });

    const handle = { chart, candleSeries, volumeSeries };
    handleRef.current = handle;
    onReady?.(handle);

    const ro = new ResizeObserver(() => {
      chart.applyOptions({ width: el.clientWidth });
    });
    ro.observe(el);
    chart.applyOptions({ width: el.clientWidth });

    return () => {
      ro.disconnect();
      chart.remove();
      handleRef.current = null;
    };
  }, [containerRef, height, onReady]);

  return handleRef;
}

export function applyCandlesToSeries(
  handle: CandleChartHandle,
  candles: Candle[],
  mode: "set" | "update" = "set",
) {
  if (!candles.length) return;
  if (mode === "set") {
    handle.candleSeries.setData(candles.map(toLwCandle));
    handle.volumeSeries.setData(candles.map(toLwVolume));
    return;
  }
  const last = candles[candles.length - 1]!;
  handle.candleSeries.update(toLwCandle(last));
  handle.volumeSeries.update(toLwVolume(last));
}

export function applyMarkers(
  handle: CandleChartHandle,
  markers: ReturnType<typeof markersToLwCharts>,
) {
  createSeriesMarkers(handle.candleSeries, markers);
}

export async function fetchCandlePage(
  mint: string,
  tf: ChartTimeframe,
  beforeId?: string,
): Promise<{ candles: Candle[]; oldestTradeId: string | null; hasMore: boolean }> {
  const q = new URLSearchParams({ tf, limit: String(CANDLE_PAGE_SIZE) });
  if (beforeId) q.set("beforeId", beforeId);
  const r = await fetch(`/api/tokens/${encodeURIComponent(mint)}/candles?${q}`, {
    cache: "no-store",
  });
  if (!r.ok) throw new Error(String(r.status));
  const j = (await r.json()) as {
    candles: Candle[];
    oldestTradeId: string | null;
    hasMore: boolean;
  };
  return j;
}

export function useScrollBackLoader(opts: {
  mint: string;
  tf: ChartTimeframe;
  handle: CandleChartHandle | null;
  oldestTradeId: string | null;
  onPrepend: (candles: Candle[], oldestTradeId: string | null) => void;
  hasMore?: boolean;
}) {
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadingRef = useRef(false);

  useEffect(() => {
    if (!opts.handle) return;
    const { chart } = opts.handle;
    const ts = chart.timeScale();

    const onRange = () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(async () => {
        const range = ts.getVisibleLogicalRange();
        if (!range || range.from > SCROLL_PREFETCH_BARS) return;
        if (loadingRef.current || !opts.oldestTradeId) return;
        loadingRef.current = true;
        const saved = ts.getVisibleLogicalRange();
        try {
          const page = await fetchCandlePage(opts.mint, opts.tf, opts.oldestTradeId);
          if (!page.candles.length) return;
          opts.onPrepend(page.candles, page.oldestTradeId);
          if (saved) {
            ts.setVisibleLogicalRange({
              from: saved.from + page.candles.length,
              to: saved.to + page.candles.length,
            });
          }
        } finally {
          loadingRef.current = false;
        }
      }, SCROLL_DEBOUNCE_MS);
    };

    ts.subscribeVisibleLogicalRangeChange(onRange);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      ts.unsubscribeVisibleLogicalRangeChange(onRange);
    };
  }, [opts.handle, opts.mint, opts.tf, opts.oldestTradeId, opts.onPrepend]);
}

import { useChartStore } from "@/components/chart/chartStore";

/** Scroll visible range to center a trade anchor time (unix seconds). */
export function scrollChartToTime(
  handle: CandleChartHandle,
  candles: Candle[],
  anchorTimeSec: number,
  barsVisible = 48,
): void {
  if (!candles.length) return;
  let idx = candles.findIndex((c) => c.time >= anchorTimeSec);
  if (idx < 0) idx = candles.length - 1;
  const half = Math.floor(barsVisible / 2);
  handle.chart.timeScale().setVisibleLogicalRange({
    from: Math.max(0, idx - half),
    to: Math.min(candles.length, idx + half),
  });
}

export function useLiveEdgeTracking(
  handle: CandleChartHandle | null,
  mint: string,
  candleCount: number,
  onLiveEdge: (atEdge: boolean) => void,
) {
  useEffect(() => {
    if (!handle) return;
    const ts = handle.chart.timeScale();
    const check = () => {
      const range = ts.getVisibleLogicalRange();
      if (!range) return;
      const atEdge = range.to >= candleCount - 2;
      onLiveEdge(atEdge);
      if (atEdge) {
        useChartStore.getState().flushLiveBuffer(mint);
      }
    };
    ts.subscribeVisibleLogicalRangeChange(check);
    check();
    return () => ts.unsubscribeVisibleLogicalRangeChange(check);
  }, [handle, mint, candleCount, onLiveEdge]);
}
