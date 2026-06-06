"use client";

import { useMemo } from "react";
import { create } from "zustand";
import type {
  Candle,
  ChartTimeframe,
  CommitBundle,
  ChartMarkerInstance,
  UserTrade,
  PriceRegime,
} from "@/lib/chart/types";
import { MAX_LIVE_BUFFER } from "@/lib/chart/constants";
import { mergeCandlePages, mergeSnapshotTail } from "@/lib/chart/data/chartCache";
import { shouldAcceptSeq, hasGap } from "@/lib/chart/realtime/eventRouter";
import { buildMarkers } from "@/lib/chart/engine/markerEngine";
import { userTradesVersion } from "@/lib/chart/engine/positionBuilder";

type ChartSeq = { epoch: number; seq: number; lastTradeId: string };

export type MintChartSlice = {
  tf: ChartTimeframe;
  historicalCandles: Candle[];
  liveBuffer: CommitBundle[];
  isAtLiveEdge: boolean;
  chartSeq: ChartSeq;
  marketCap: number;
  regime: PriceRegime;
  markersById: Map<string, ChartMarkerInstance>;
  userTrades: UserTrade[];
  userTradesVersion: string;
  loading: boolean;
  error: string | null;
  oldestTradeId: string | null;
  wsConnected: boolean;
  resyncFlag: number;
};

function emptySlice(): MintChartSlice {
  return {
    tf: "1m",
    historicalCandles: [],
    liveBuffer: [],
    isAtLiveEdge: true,
    chartSeq: { epoch: 1, seq: 0, lastTradeId: "0" },
    marketCap: 0,
    regime: "bonding_curve",
    markersById: new Map(),
    userTrades: [],
    userTradesVersion: "",
    loading: true,
    error: null,
    oldestTradeId: null,
    wsConnected: false,
    resyncFlag: 0,
  };
}

function patchCandlesFromBundle(candles: Candle[], bundle: CommitBundle, tf: ChartTimeframe): Candle[] {
  const patches = bundle.candlePatches.filter((p) => p.tf === tf);
  if (!patches.length) return candles;
  const map = new Map(candles.map((c) => [c.time, c]));
  for (const p of patches) {
    const t = Math.floor(p.bucketTime / 1000);
    map.set(t, p.candle);
  }
  return [...map.values()].sort((a, b) => a.time - b.time);
}

type Store = {
  slices: Record<string, MintChartSlice>;
  resetMint: (mint: string) => void;
  setTf: (mint: string, tf: ChartTimeframe) => void;
  setAtLiveEdge: (mint: string, v: boolean) => void;
  setHistorical: (mint: string, candles: Candle[], oldestTradeId: string | null) => void;
  prependHistorical: (mint: string, older: Candle[], oldestTradeId: string | null) => void;
  setUserTrades: (mint: string, fills: UserTrade[]) => void;
  applySnapshot: (
    mint: string,
    opts: {
      candles: Candle[];
      marketCap: number;
      epoch: number;
      lastTradeId: string;
      regime?: PriceRegime;
    },
  ) => void;
  applyBundle: (mint: string, bundle: CommitBundle) => void;
  setRegime: (mint: string, regime: PriceRegime) => void;
  flushLiveBuffer: (mint: string) => CommitBundle[];
  requestResync: (mint: string) => void;
  setWsConnected: (mint: string, v: boolean) => void;
};

function updateSlice(
  set: (fn: (s: Store) => Partial<Store>) => void,
  get: () => Store,
  mint: string,
  patch: Partial<MintChartSlice> | ((prev: MintChartSlice) => Partial<MintChartSlice>),
) {
  set((s) => {
    const prev = s.slices[mint] ?? emptySlice();
    const delta = typeof patch === "function" ? patch(prev) : patch;
    return { slices: { ...s.slices, [mint]: { ...prev, ...delta } } };
  });
}

export const useChartStore = create<Store>((set, get) => ({
  slices: {},

  resetMint: (mint) => set((s) => ({ slices: { ...s.slices, [mint]: emptySlice() } })),

  setTf: (mint, tf) => {
    updateSlice(set, get, mint, (prev) => ({
      tf,
      markersById: buildMarkers(prev.userTrades, tf),
    }));
  },

  setAtLiveEdge: (mint, v) => updateSlice(set, get, mint, { isAtLiveEdge: v }),

  setHistorical: (mint, candles, oldestTradeId) =>
    updateSlice(set, get, mint, { historicalCandles: candles, oldestTradeId, loading: false }),

  prependHistorical: (mint, older, oldestTradeId) => {
    updateSlice(set, get, mint, (prev) => ({
      historicalCandles: mergeCandlePages(prev.historicalCandles, older),
      oldestTradeId: oldestTradeId ?? prev.oldestTradeId,
    }));
  },

  setUserTrades: (mint, fills) => {
    updateSlice(set, get, mint, (prev) => {
      const tf = prev.tf;
      return {
        userTrades: fills,
        userTradesVersion: userTradesVersion(fills),
        markersById: buildMarkers(fills, tf),
      };
    });
  },

  applySnapshot: (mint, { candles, marketCap, epoch, lastTradeId, regime }) => {
    updateSlice(set, get, mint, (prev) => ({
      historicalCandles:
        prev.historicalCandles.length > 0 ? mergeSnapshotTail(prev.historicalCandles, candles) : candles,
      marketCap,
      regime: regime ?? prev.regime,
      chartSeq: { epoch, seq: 0, lastTradeId },
      loading: false,
      liveBuffer: [],
    }));
  },

  applyBundle: (mint, bundle) => {
    const prev = get().slices[mint] ?? emptySlice();
    const next = {
      epoch: bundle.epoch,
      seq: bundle.seq,
      lastTradeId: bundle.lastTradeId,
    };
    if (!shouldAcceptSeq(prev.chartSeq, next)) return;
    if (hasGap(prev.chartSeq.lastTradeId, bundle.lastTradeId, bundle.trades[0]?.tradeId)) {
      updateSlice(set, get, mint, { resyncFlag: prev.resyncFlag + 1 });
      return;
    }
    if (!prev.isAtLiveEdge) {
      updateSlice(set, get, mint, {
        liveBuffer: [...prev.liveBuffer, bundle].slice(-MAX_LIVE_BUFFER),
        chartSeq: next,
        marketCap: bundle.marketCap,
        regime: bundle.regime,
      });
      return;
    }
    updateSlice(set, get, mint, {
      historicalCandles: patchCandlesFromBundle(prev.historicalCandles, bundle, prev.tf),
      chartSeq: next,
      marketCap: bundle.marketCap,
      regime: bundle.regime,
    });
  },

  setRegime: (mint, regime) => updateSlice(set, get, mint, { regime }),

  flushLiveBuffer: (mint) => {
    const prev = get().slices[mint] ?? emptySlice();
    const buf = [...prev.liveBuffer];
    if (!buf.length) return buf;
    let candles = prev.historicalCandles;
    let marketCap = prev.marketCap;
    let chartSeq = prev.chartSeq;
    let regime = prev.regime;
    for (const b of buf) {
      candles = patchCandlesFromBundle(candles, b, prev.tf);
      marketCap = b.marketCap;
      regime = b.regime;
      chartSeq = { epoch: b.epoch, seq: b.seq, lastTradeId: b.lastTradeId };
    }
    updateSlice(set, get, mint, {
      historicalCandles: candles,
      liveBuffer: [],
      marketCap,
      chartSeq,
      regime,
      isAtLiveEdge: true,
    });
    return buf;
  },

  requestResync: (mint) =>
    updateSlice(set, get, mint, (prev) => ({ resyncFlag: prev.resyncFlag + 1 })),

  setWsConnected: (mint, wsConnected) => updateSlice(set, get, mint, { wsConnected }),
}));

/** Per-mint chart state — multiple charts can mount without clobbering each other. */
export function useChartMint(mint: string) {
  const slice = useChartStore((s) => s.slices[mint]);
  return useMemo(() => {
    const s = slice ?? emptySlice();
    const api = useChartStore.getState();
    return {
      ...s,
      resetMint: () => api.resetMint(mint),
      setTf: (tf: ChartTimeframe) => api.setTf(mint, tf),
      setAtLiveEdge: (v: boolean) => api.setAtLiveEdge(mint, v),
      setHistorical: (candles: Candle[], oldestTradeId: string | null) =>
        api.setHistorical(mint, candles, oldestTradeId),
      prependHistorical: (older: Candle[], oldestTradeId: string | null) =>
        api.prependHistorical(mint, older, oldestTradeId),
      setUserTrades: (fills: UserTrade[]) => api.setUserTrades(mint, fills),
      applySnapshot: (opts: Parameters<Store["applySnapshot"]>[1]) => api.applySnapshot(mint, opts),
      applyBundle: (bundle: CommitBundle) => api.applyBundle(mint, bundle),
      setRegime: (regime: PriceRegime) => api.setRegime(mint, regime),
      flushLiveBuffer: () => api.flushLiveBuffer(mint),
      requestResync: () => api.requestResync(mint),
      setWsConnected: (v: boolean) => api.setWsConnected(mint, v),
    };
  }, [mint, slice]);
}

export function fmtMcap(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}K`;
  return `$${Math.round(v)}`;
}

export function fmtPct(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const p = v * 100;
  return `${p >= 0 ? "+" : ""}${p.toFixed(1)}%`;
}
