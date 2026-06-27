"use client";

/**
 * TradingChart — Axiom-style terminal chart: WS stream, 9 timeframes,
 * OHLCV legend, MA/RSI indicators, volume pane, log scale, side HUD.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createChart,
  createSeriesMarkers,
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  PriceScaleMode,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import type { Candle, ChartMarkerInstance, ChartTimeframe, UserTrade } from "@/lib/chart/types";
import { SCROLL_DEBOUNCE_MS, SCROLL_PREFETCH_BARS, TF_BAR_SPACING, PUMP_SUPPLY } from "@/lib/chart/constants";
import { DEFAULT_CHART_TF } from "@/lib/chart/timeframes";
import { ema, rsi, sma } from "@/lib/chart/engine/indicators";
import { anchorTimeForTrade, findMarkerAtCrosshair } from "@/lib/chart/engine/markerEngine";
import { unitPriceFromMcap } from "@/lib/chart/data/marketCap";
import { tradesToBsMarkers, snapCandleTime, type BsMarker } from "@/components/chart/bsMarkers";
import { GraduationLinePrimitive } from "@/components/chart/graduationLine";
import { applyCandlesToSeries, toLwCandle } from "@/components/chart/CandleSeries";
import type { ApplyResult } from "@/components/chart/CandleSeries";
import { ChartOhlcvLegend, findCandleAtTime, latestBar } from "@/components/chart/ChartOhlcvLegend";
import { ChartSideHud } from "@/components/chart/ChartSideHud";
import { ChartToolbar } from "@/components/chart/ChartToolbar";
import { CHART_THEME, DEFAULT_INDICATORS, type ChartIndicatorState } from "@/components/chart/chartTheme";
import { useChartStream } from "@/components/chart/useChartStream";
import { fmtAxisMcap, fmtPct } from "@/components/chart/format";

function toLine(points: { time: number; value: number }[]) {
  return points.map((p) => ({ time: p.time as UTCTimestamp, value: p.value }));
}

/** Map trade markers to native LWC v5 series markers: clear green ▲ Buy / red ▼ Sell. */
function toNativeMarkers(bs: BsMarker[]): SeriesMarker<Time>[] {
  return [...bs]
    .sort((a, b) => (a.time as number) - (b.time as number))
    .map((m): SeriesMarker<Time> =>
      m.side === "buy"
        ? { time: m.time, position: "belowBar", shape: "arrowUp", color: CHART_THEME.buyMarker, text: "Buy" }
        : { time: m.time, position: "aboveBar", shape: "arrowDown", color: CHART_THEME.sellMarker, text: "Sell" },
    );
}

function sessionChangePct(candles: Candle[]): number | null {
  if (candles.length < 2) return null;
  const first = candles[0]!;
  const last = candles[candles.length - 1]!;
  if (first.open <= 0) return null;
  return (last.close - first.open) / first.open;
}

export function TradingChart({
  mint,
  symbol,
  height = 520,
  entryMcapUsd,
  currentMcapUsd,
  pnlPct,
  status,
  userTrades,
  showSideHud = true,
  scrollToBuy = false,
}: {
  mint: string;
  symbol?: string | null;
  height?: number;
  entryMcapUsd?: number | null;
  currentMcapUsd?: number | null;
  pnlPct?: number | null;
  status?: "open" | "closed";
  userTrades?: UserTrade[];
  showSideHud?: boolean;
  scrollToBuy?: boolean;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const ma7Ref = useRef<ISeriesApi<"Line"> | null>(null);
  const ma25Ref = useRef<ISeriesApi<"Line"> | null>(null);
  const rsiRef = useRef<ISeriesApi<"Line"> | null>(null);
  const markersPluginRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const gradPrimRef = useRef<GraduationLinePrimitive | null>(null);
  const entryLineRef = useRef<IPriceLine | null>(null);

  const prevCandlesRef = useRef<Candle[]>([]);
  const appliedKeyRef = useRef("");
  const markerMapRef = useRef<Map<string, ChartMarkerInstance>>(new Map());
  const tfRef = useRef<ChartTimeframe>(DEFAULT_CHART_TF);
  const scrolledToBuyRef = useRef(false);
  const atLiveEdgeRef = useRef(true);

  const [tf, setTf] = useState<ChartTimeframe>(DEFAULT_CHART_TF);
  const [copied, setCopied] = useState(false);
  const [logScale, setLogScale] = useState(false);
  const [indicators, setIndicators] = useState<ChartIndicatorState>(DEFAULT_INDICATORS);
  const [atLiveEdge, setAtLiveEdge] = useState(true);
  const [legendCandle, setLegendCandle] = useState<Candle | null>(null);
  const [legendTime, setLegendTime] = useState<number | null>(null);
  const [markerHover, setMarkerHover] = useState<ChartMarkerInstance | null>(null);
  // Fast live mcap polled directly from DexScreener (~2.5s) for near-real-time price.
  const [liveMcapFast, setLiveMcapFast] = useState<number | null>(null);

  const {
    candles,
    marketCap,
    regime,
    loading,
    live,
    loadOlder,
    setAtLiveEdge: setStreamLiveEdge,
    markersById,
    graduationAt,
  } = useChartStream(mint, tf, userTrades ?? []);

  const bsMarkers = useMemo(
    () => tradesToBsMarkers(userTrades ?? [], tf, candles),
    [userTrades, tf, candles],
  );
  const changePct = useMemo(() => sessionChangePct(candles), [candles]);
  const gradTimeSec = useMemo(() => {
    if (!graduationAt) return null;
    const gradSec = Math.floor(graduationAt / 1000);
    // Only draw the graduation line when bonding-curve candles actually exist before
    // the graduation time. Without real curve history the "graduation" anchor is
    // coin.lastTradeAt (not the actual migration time) and the line lands right on
    // top of the only DEX candle, which is visually misleading.
    const hasCurveHistory = candles.some((c) => c.time < gradSec && c.volume > 0);
    if (!hasCurveHistory) return null;
    return snapCandleTime(candles, gradSec);
  }, [graduationAt, candles]);
  const displayLegend = legendCandle ?? latestBar(candles);

  tfRef.current = tf;
  markerMapRef.current = markersById;
  atLiveEdgeRef.current = atLiveEdge;

  const loadOlderRef = useRef(loadOlder);
  loadOlderRef.current = loadOlder;
  const setStreamLiveEdgeRef = useRef(setStreamLiveEdge);
  setStreamLiveEdgeRef.current = setStreamLiveEdge;

  const goLive = useCallback(() => {
    chartRef.current?.timeScale().scrollToRealTime();
    setAtLiveEdge(true);
    setStreamLiveEdge(true);
  }, [setStreamLiveEdge]);

  // Chart mount
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;

    const chart = createChart(el, {
      height,
      autoSize: false,
      layout: {
        background: { color: CHART_THEME.bg },
        textColor: CHART_THEME.text,
        fontSize: 11,
        fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
        attributionLogo: false,
      },
      localization: { priceFormatter: fmtAxisMcap },
      grid: {
        vertLines: { color: CHART_THEME.grid },
        horzLines: { color: CHART_THEME.grid },
      },
      rightPriceScale: {
        borderVisible: false,
        ticksVisible: true,
        scaleMargins: { top: 0.08, bottom: 0.05 },
      },
      timeScale: {
        borderVisible: false,
        timeVisible: true,
        secondsVisible: true,
        barSpacing: TF_BAR_SPACING[DEFAULT_CHART_TF],
        minBarSpacing: 2,
        rightOffset: 8,
        lockVisibleTimeRangeOnResize: true,
      },
      crosshair: {
        mode: 1,
        vertLine: { color: CHART_THEME.crosshair, width: 1, style: 3, labelBackgroundColor: CHART_THEME.crosshairLabel },
        horzLine: { color: CHART_THEME.crosshair, width: 1, style: 3, labelBackgroundColor: CHART_THEME.crosshairLabel },
      },
    });

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: CHART_THEME.up,
      downColor: CHART_THEME.down,
      borderVisible: true,
      borderUpColor: CHART_THEME.up,
      borderDownColor: CHART_THEME.down,
      wickUpColor: CHART_THEME.up,
      wickDownColor: CHART_THEME.down,
      lastValueVisible: true,
      priceLineVisible: true,
      priceLineColor: CHART_THEME.live,
      priceLineWidth: 1,
      priceLineStyle: 2,
      // Unit prices for pump tokens are ~1e-5. The default minMove:0.01 causes
      // LWC to treat the entire visible price range as sub-tick → all candles
      // collapse to the same Y coordinate. Set minMove small enough that the
      // internal scale resolves individual price levels correctly.
      // localization.priceFormatter (fmtAxisMcap) still controls all display text.
      priceFormat: { type: "price", minMove: 1e-10 },
    }, 0);

    const volumeSeries = chart.addSeries(
      HistogramSeries,
      { priceFormat: { type: "volume" } },
      1,
    );
    chart.panes()[1]?.setHeight(72);

    const maFmt = { type: "price" as const, minMove: 1e-10 };
    const ma7 = chart.addSeries(LineSeries, { color: CHART_THEME.ma7, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, priceFormat: maFmt }, 0);
    const ma25 = chart.addSeries(LineSeries, { color: CHART_THEME.ma25, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, priceFormat: maFmt }, 0);
    const rsiSeries = chart.addSeries(
      LineSeries,
      { color: CHART_THEME.rsi, lineWidth: 1, priceLineVisible: false, lastValueVisible: false },
      2,
    );
    chart.panes()[2]?.setHeight(64);

    const markersPlugin = createSeriesMarkers(candleSeries, []);

    const gradPrimitive = new GraduationLinePrimitive();
    candleSeries.attachPrimitive(gradPrimitive);

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    volumeSeriesRef.current = volumeSeries;
    ma7Ref.current = ma7;
    ma25Ref.current = ma25;
    rsiRef.current = rsiSeries;
    markersPluginRef.current = markersPlugin;
    gradPrimRef.current = gradPrimitive;
    prevCandlesRef.current = [];
    appliedKeyRef.current = "";

    const onCrosshair = chart.subscribeCrosshairMove((param) => {
      if (!param.time) {
        setLegendCandle(null);
        setLegendTime(null);
        setMarkerHover(null);
        return;
      }
      const t = param.time as number;
      const marker = findMarkerAtCrosshair(markerMapRef.current, t, tfRef.current);
      if (marker) {
        setMarkerHover(marker);
        setLegendCandle(null);
        setLegendTime(t);
        return;
      }
      setMarkerHover(null);
      const c = findCandleAtTime(prevCandlesRef.current, t);
      setLegendCandle(c);
      setLegendTime(t);
    });

    const ts = chart.timeScale();
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const onRange = () => {
      const range = ts.getVisibleLogicalRange();
      if (range) {
        const lastIdx = candleSeries.data()?.length ?? 0;
        const edge = lastIdx === 0 || range.to >= lastIdx - 2;
        setAtLiveEdge(edge);
        setStreamLiveEdgeRef.current(edge);
      }
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(async () => {
        const range = ts.getVisibleLogicalRange();
        if (!range || range.from > SCROLL_PREFETCH_BARS) return;
        const saved = ts.getVisibleLogicalRange();
        const added = await loadOlderRef.current();
        if (added > 0 && saved) {
          ts.setVisibleLogicalRange({ from: saved.from + added, to: saved.to + added });
        }
      }, SCROLL_DEBOUNCE_MS);
    };
    ts.subscribeVisibleLogicalRangeChange(onRange);

    const ro = new ResizeObserver(() => chart.applyOptions({ width: el.clientWidth }));
    ro.observe(el);
    chart.applyOptions({ width: el.clientWidth });

    return () => {
      ro.disconnect();
      if (debounce) clearTimeout(debounce);
      ts.unsubscribeVisibleLogicalRangeChange(onRange);
      chart.unsubscribeCrosshairMove(onCrosshair as never);
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
      ma7Ref.current = null;
      ma25Ref.current = null;
      rsiRef.current = null;
      markersPluginRef.current = null;
      gradPrimRef.current = null;
      entryLineRef.current = null;
    };
  }, [height]);

  // TF bar spacing + log scale
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    chart.timeScale().applyOptions({ barSpacing: TF_BAR_SPACING[tf] });
    chart.priceScale("right").applyOptions({
      mode: logScale ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal,
    });
  }, [tf, logScale]);

  // DEX tokens have no real sub-minute OHLCV (GeckoTerminal min resolution is 1m,
  // and those frames are hidden for DEX). If a DEX chart lands on one, snap to 1m.
  useEffect(() => {
    if (regime === "dex" && (tf === "1s" || tf === "5s" || tf === "15s")) setTf("1m");
  }, [regime, tf]);

  // Pane visibility for volume / RSI
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const panes = chart.panes();
    panes[1]?.setHeight(indicators.volume ? 72 : 0);
    panes[2]?.setHeight(indicators.rsi ? 64 : 0);
    volumeSeriesRef.current?.applyOptions({ visible: indicators.volume });
    ma7Ref.current?.applyOptions({ visible: indicators.ma7 });
    ma25Ref.current?.applyOptions({ visible: indicators.ma25 });
    rsiRef.current?.applyOptions({ visible: indicators.rsi });
  }, [indicators]);

  // Candles + indicators data
  useEffect(() => {
    const candleSeries = candleSeriesRef.current;
    const volumeSeries = volumeSeriesRef.current;
    const chart = chartRef.current;
    if (!candleSeries || !volumeSeries || !chart) return;

    const key = `${mint}:${tf}`;
    const prev = prevCandlesRef.current;
    const isReset = appliedKeyRef.current !== key || !candles.length;

    if (candles.length) {
      const ts = chart.timeScale();
      const saved = isReset ? null : ts.getVisibleLogicalRange();
      // applyCandlesToSeries handles both candle and volume series (setData or update).
      // Do NOT call volumeSeries.setData separately — that would double-reset on every tick.
      const { candles: applied, structural, firstDiff }: ApplyResult = applyCandlesToSeries(
        candleSeries,
        volumeSeries,
        prev,
        candles,
        { reset: isReset },
      );
      prevCandlesRef.current = applied;

      // For indicator lines: only the last point changes on a live tick.
      // Use setData on structural resets or historical corrections; update() otherwise.
      const liveOnly = !structural && firstDiff >= candles.length - 1;

      if (indicators.ma7) {
        const line = toLine(sma(candles, 7));
        if (!liveOnly) ma7Ref.current?.setData(line);
        else if (line.length > 0) ma7Ref.current?.update(line[line.length - 1]!);
      }
      if (indicators.ma25) {
        const line = toLine(ema(candles, 25));
        if (!liveOnly) ma25Ref.current?.setData(line);
        else if (line.length > 0) ma25Ref.current?.update(line[line.length - 1]!);
      }
      if (indicators.rsi) {
        const line = toLine(rsi(candles, 14));
        if (!liveOnly) rsiRef.current?.setData(line);
        else if (line.length > 0) rsiRef.current?.update(line[line.length - 1]!);
      }
      if (saved) ts.setVisibleLogicalRange(saved);
      else if (isReset && candles.length <= 50 && !scrollToBuy) {
        ts.fitContent();
        // fitContent stretches a handful of candles across the whole width, which
        // makes them look like thin "dashes". Cap the bar spacing so they keep a
        // readable candle width and sit at the live edge instead.
        const bs = ts.options().barSpacing;
        if (typeof bs === "number" && bs > 16) {
          ts.applyOptions({ barSpacing: 16 });
          ts.scrollToRealTime();
        }
      } else if (!scrollToBuy && atLiveEdgeRef.current) ts.scrollToRealTime();

      // Only stamp the key after candles have actually been applied.
      // If candles is empty (loading after TF switch), keep the old key so the
      // next render — when data arrives — still sees isReset=true and resets
      // the viewport correctly instead of restoring the old TF's index range.
      appliedKeyRef.current = key;
    }
  }, [candles, mint, tf, indicators, scrollToBuy]);

  // Fast live price: poll DexScreener (~2.5s) for the focused token so the price
  // line tracks the market in near-real-time instead of waiting on Gecko's ~20s
  // OHLCV cache. Critical for trading. Pauses while the tab is hidden.
  useEffect(() => {
    if (!mint || mint.length < 32) return;
    let alive = true;
    const poll = async () => {
      if (typeof document !== "undefined" && document.hidden) return;
      try {
        const r = await fetch(`/api/tokens/${encodeURIComponent(mint)}/live-price`, { cache: "no-store" });
        if (!r.ok) return;
        const j = (await r.json()) as { mcapUsd: number | null };
        if (alive && j.mcapUsd != null && j.mcapUsd > 0) setLiveMcapFast(j.mcapUsd);
      } catch {
        /* ignore */
      }
    };
    void poll();
    // T2.2 — collapse the polling stack. When the WS is connected it already
    // pushes fresh prices, so this on-chain poll is mostly redundant — back it
    // off to 3s to free the Helius budget the ingestor competes for. When the WS
    // is down, this poll is the only fresh source, so keep it at 1.5s.
    const intervalMs = live ? 3000 : 1500;
    const id = setInterval(poll, intervalMs);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [mint, live]);

  // Reset the fast price when the focused token changes.
  useEffect(() => {
    setLiveMcapFast(null);
  }, [mint]);

  // Live mcap: drive the last candle's close from the freshest live mcap (the fast
  // on-chain poll, else the position's value) so the price line moves in real time
  // (like DexScreener), even when the OHLCV source lags. Runs after the candle
  // effect to override the last bar. Updating the (rightmost) last bar does not
  // move a scrolled-back view, so it runs regardless of live-edge. Does not touch
  // prevCandlesRef, so it never interferes with historical diffing.
  useEffect(() => {
    const series = candleSeriesRef.current;
    if (!series) return;
    const live = liveMcapFast ?? currentMcapUsd ?? null;
    if (live == null || live <= 0) return;
    const applied = prevCandlesRef.current;
    if (!applied.length) return;
    const last = applied[applied.length - 1]!;
    const liveClose = unitPriceFromMcap(live);
    if (liveClose <= 0 || Math.abs(liveClose - last.close) <= last.close * 1e-9) return;
    series.update(
      toLwCandle({
        ...last,
        close: liveClose,
        high: Math.max(last.high, liveClose),
        low: Math.min(last.low, liveClose),
      }),
    );
  }, [liveMcapFast, currentMcapUsd, candles]);

  // Markers update independently from candles — every buy/sell immediately
  // updates the native marker layer without triggering a full candle rebuild.
  // The migration point gets a distinct blue "M" circle ON the boundary candle
  // (clearer than the vertical line alone). It must share the buy/sell marker
  // layer (one markers plugin per series) and stay time-sorted ascending.
  useEffect(() => {
    const native = toNativeMarkers(bsMarkers);
    if (gradTimeSec != null) {
      native.push({
        time: gradTimeSec as Time,
        position: "aboveBar",
        color: "#3b82f6",
        shape: "circle",
        text: "M",
      });
      native.sort((a, b) => (a.time as number) - (b.time as number));
    }
    markersPluginRef.current?.setMarkers(native);
  }, [bsMarkers, gradTimeSec]);

  // Entry price horizontal line (Axiom-style)
  useEffect(() => {
    const series = candleSeriesRef.current;
    if (!series) return;
    if (entryLineRef.current) {
      series.removePriceLine(entryLineRef.current);
      entryLineRef.current = null;
    }
    if (entryMcapUsd != null && entryMcapUsd > 0) {
      const price = unitPriceFromMcap(entryMcapUsd);
      if (price > 0) {
        entryLineRef.current = series.createPriceLine({
          price,
          color: CHART_THEME.accent,
          lineWidth: 1,
          lineStyle: 2,
          axisLabelVisible: true,
          title: "Entry",
        });
      }
    }
  }, [entryMcapUsd]);

  // Graduation vertical boundary
  useEffect(() => {
    gradPrimRef.current?.setGraduationTime(gradTimeSec);
  }, [gradTimeSec]);

  useEffect(() => {
    scrolledToBuyRef.current = false;
  }, [mint, tf]);

  useEffect(() => {
    if (!scrollToBuy || scrolledToBuyRef.current) return;
    const chart = chartRef.current;
    if (!chart || !candles.length) return;
    const buy = (userTrades ?? []).find((t) => t.side === "buy");
    if (!buy) return;
    const anchor = anchorTimeForTrade(buy.timestamp, tf);
    let idx = candles.findIndex((c) => c.time >= anchor);
    if (idx < 0) idx = candles.length - 1;
    chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, idx - 24), to: Math.min(candles.length, idx + 24) });
    setAtLiveEdge(false);
    setStreamLiveEdge(false);
    scrolledToBuyRef.current = true;
  }, [scrollToBuy, candles, userTrades, tf, setStreamLiveEdge]);

  // Live mcap: prefer the position's live mcap (currentMcapUsd) — it's the freshest
  // price and is what we also paint onto the last candle (so the green price line,
  // the toolbar, and this HUD all agree and move together). Fall back to the chart's
  // own latest candle when there's no live value.
  const lastCandle = candles.length ? candles[candles.length - 1]! : null;
  const chartMcap = lastCandle && lastCandle.close > 0 ? lastCandle.close * PUMP_SUPPLY : 0;
  const liveMcap =
    liveMcapFast != null && liveMcapFast > 0
      ? liveMcapFast
      : currentMcapUsd != null && currentMcapUsd > 0
        ? currentMcapUsd
        : chartMcap > 0
          ? chartMcap
          : marketCap > 0
            ? marketCap
            : entryMcapUsd;

  const copy = useCallback(() => {
    const markCopied = () => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    };
    // Prefer the async Clipboard API (works in secure contexts), but fall back to
    // a hidden textarea + execCommand for iframes / insecure contexts where the
    // Clipboard API is blocked — otherwise the copy silently fails.
    const fallback = () => {
      try {
        const ta = document.createElement("textarea");
        ta.value = mint;
        ta.style.position = "fixed";
        ta.style.top = "0";
        ta.style.left = "0";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        markCopied();
      } catch {
        /* give up silently */
      }
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(mint).then(markCopied, fallback);
    } else {
      fallback();
    }
  }, [mint]);

  return (
    <div className="overflow-hidden rounded-lg" style={{ border: `1px solid ${CHART_THEME.border}`, background: CHART_THEME.bg }}>
      <ChartToolbar
        mint={mint}
        symbol={symbol}
        regime={regime}
        tf={tf}
        onTf={setTf}
        live={live}
        logScale={logScale}
        onLogScale={() => setLogScale((v) => !v)}
        indicators={indicators}
        onIndicators={(p) => setIndicators((s) => ({ ...s, ...p }))}
        onCopy={copy}
        copied={copied}
        onGoLive={goLive}
        atLiveEdge={atLiveEdge}
        marketCap={liveMcap}
        changePct={changePct}
      />

      <div className="flex flex-col sm:flex-row">
        <div ref={wrapRef} style={{ height: `${height}px` }} className="relative min-h-0 w-full flex-1">
          {loading && (
            <div className="absolute inset-0 z-10 flex items-center justify-center text-xs" style={{ color: CHART_THEME.text }}>
              Loading chart…
            </div>
          )}
          {!loading && !candles.length && (
            <div className="absolute inset-0 z-10 flex items-center justify-center text-xs" style={{ color: CHART_THEME.text }}>
              No candle data yet
            </div>
          )}
          {!markerHover && <ChartOhlcvLegend candle={displayLegend} timeSec={legendTime} />}
          {markerHover && (
            <div
              className="pointer-events-none absolute left-2 top-2 z-10 rounded px-1.5 py-1 text-[10px]"
              style={{ background: "rgba(17,24,32,0.92)", border: `1px solid ${CHART_THEME.border}` }}
            >
              <div style={{ color: markerHover.side === "buy" ? CHART_THEME.up : CHART_THEME.down }}>
                {markerHover.side === "buy" ? "Buy" : "Sell"}
                {markerHover.amount > 0 ? ` · ${markerHover.amount.toFixed(3)} SOL` : ""}
              </div>
              <div className="font-mono font-semibold" style={{ color: CHART_THEME.textBright }}>
                {fmtAxisMcap(markerHover.price)}
              </div>
              {markerHover.pnl != null && (
                <div style={{ color: markerHover.pnl >= 0 ? CHART_THEME.up : CHART_THEME.down }}>
                  PnL {fmtPct(markerHover.pnl)}
                </div>
              )}
            </div>
          )}
        </div>
        {showSideHud && (
          <ChartSideHud status={status} liveMcap={liveMcap} entryMcapUsd={entryMcapUsd} pnlPct={pnlPct} />
        )}
      </div>
    </div>
  );
}

export const PriceChart = TradingChart;
