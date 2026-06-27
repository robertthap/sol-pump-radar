"use client";

import type {
  Candle,
  CandlePatch,
  ChartMarkerInstance,
  ChartTimeframe,
  CommitBundle,
  PriceRegime,
  SyncSnapshot,
} from "@/lib/chart/types";
import { MAX_LIVE_BUFFER } from "@/lib/chart/constants";
import { mergeCandlePages, mergeSnapshotTail } from "@/lib/chart/data/chartCache";
import { userTradesVersion } from "@/lib/chart/engine/positionBuilder";
import type { UserTrade } from "@/lib/chart/types";
import { buildMarkers } from "@/lib/chart/engine/markerEngine";

export type ChartMintSlice = {
  mint: string;
  tf: ChartTimeframe;
  historicalCandles: Candle[];
  liveBuffer: CommitBundle[];
  isAtLiveEdge: boolean;
  lastTradeId: string;
  chartSeq: { epoch: number; seq: number };
  marketCap: number;
  regime: PriceRegime;
  graduationAt: number | null;
  markersById: Map<string, ChartMarkerInstance>;
  userTradesVersion: string;
  loading: boolean;
  wsConnected: boolean;
  oldestTradeId: string | null;
  hasMore: boolean;
};

export function createInitialSlice(mint: string, tf: ChartTimeframe): ChartMintSlice {
  return {
    mint,
    tf,
    historicalCandles: [],
    liveBuffer: [],
    isAtLiveEdge: true,
    lastTradeId: "0",
    chartSeq: { epoch: 1, seq: 0 },
    marketCap: 0,
    regime: "bonding_curve",
    graduationAt: null,
    markersById: new Map(),
    userTradesVersion: "",
    loading: true,
    wsConnected: false,
    oldestTradeId: null,
    hasMore: false,
  };
}

export function mergeCandlePatches(
  candles: Candle[],
  patches: CandlePatch[],
  tf: ChartTimeframe,
): Candle[] {
  if (!patches.length) return candles;
  const map = new Map<number, Candle>();
  for (const c of candles) map.set(c.time, c);
  for (const p of patches) {
    if (p.tf !== tf) continue;
    map.set(p.candle.time, p.candle);
  }
  return [...map.values()].sort((a, b) => a.time - b.time);
}

function applyBundleToCandles(
  candles: Candle[],
  bundle: CommitBundle,
  tf: ChartTimeframe,
): Candle[] {
  return mergeCandlePatches(candles, bundle.candlePatches, tf);
}

export function flushLiveBuffer(slice: ChartMintSlice): ChartMintSlice {
  if (!slice.liveBuffer.length) return slice;
  let candles = slice.historicalCandles;
  let marketCap = slice.marketCap;
  let lastTradeId = slice.lastTradeId;
  let regime = slice.regime;
  let chartSeq = slice.chartSeq;
  for (const b of slice.liveBuffer) {
    candles = applyBundleToCandles(candles, b, slice.tf);
    marketCap = b.marketCap;
    lastTradeId = b.lastTradeId;
    regime = b.regime;
    chartSeq = { epoch: b.epoch, seq: b.seq };
  }
  return {
    ...slice,
    historicalCandles: candles,
    liveBuffer: [],
    marketCap,
    lastTradeId,
    regime,
    chartSeq,
  };
}

export function applyCommitBundle(
  slice: ChartMintSlice,
  bundle: CommitBundle,
): ChartMintSlice {
  if (slice.isAtLiveEdge) {
    return {
      ...slice,
      historicalCandles: applyBundleToCandles(slice.historicalCandles, bundle, slice.tf),
      marketCap: bundle.marketCap,
      lastTradeId: bundle.lastTradeId,
      regime: bundle.regime,
      graduationAt: bundle.regimeSwitch?.graduationAt ?? slice.graduationAt,
      chartSeq: { epoch: bundle.epoch, seq: bundle.seq },
    };
  }
  const buf = [...slice.liveBuffer, bundle];
  while (buf.length > MAX_LIVE_BUFFER) buf.shift();
  return { ...slice, liveBuffer: buf };
}

/** Parse a trade-id string to BigInt; non-numeric / empty → 0n. */
function tradeIdBig(id: string | null | undefined): bigint {
  if (!id) return 0n;
  try {
    return BigInt(id);
  } catch {
    return 0n;
  }
}

/**
 * T2.1 — snapshot-authority version guard (the "fixes don't stick" bug).
 *
 * A SYNC_SNAPSHOT is the worker's authoritative state at the moment it was built.
 * But the client may have already advanced past it via COMMIT_BUNDLEs (or a REST
 * correction). Applying a STALE snapshot then reverts the chart to older data —
 * the user sees a fix land and then disappear seconds later.
 *
 * Monotonic version = (epoch, lastTradeId). Drop a snapshot that is not strictly
 * newer than what we already hold:
 *   - older epoch          → drop (stale; a newer epoch already reset us)
 *   - same epoch, behind   → drop (we're already ahead via live bundles)
 *   - newer epoch          → accept (authoritative reset, e.g. worker restart)
 *   - same epoch, at/ahead → accept (legitimate sync/resync)
 */
export function applySyncSnapshot(slice: ChartMintSlice, snap: SyncSnapshot): ChartMintSlice {
  const curEpoch = slice.chartSeq.epoch;
  if (snap.epoch < curEpoch) return slice; // stale epoch — drop
  if (snap.epoch === curEpoch && tradeIdBig(snap.lastTradeId) < tradeIdBig(slice.lastTradeId)) {
    return slice; // same epoch but behind our live state — drop
  }
  return {
    ...slice,
    historicalCandles: mergeSnapshotTail(slice.historicalCandles, snap.candles),
    marketCap: snap.marketCap,
    regime: snap.regime,
    graduationAt: snap.graduationAt ?? slice.graduationAt,
    lastTradeId: snap.lastTradeId,
    chartSeq: { epoch: snap.epoch, seq: 0 },
    liveBuffer: [],
    loading: false,
  };
}

export function setHistoricalPage(
  slice: ChartMintSlice,
  page: { candles: Candle[]; oldestTradeId: string | null; hasMore: boolean },
): ChartMintSlice {
  return {
    ...slice,
    historicalCandles: page.candles,
    oldestTradeId: page.oldestTradeId,
    hasMore: page.hasMore,
    loading: false,
  };
}

export function prependHistoricalPage(
  slice: ChartMintSlice,
  page: { candles: Candle[]; oldestTradeId: string | null; hasMore: boolean },
): ChartMintSlice {
  return {
    ...slice,
    historicalCandles: mergeCandlePages(slice.historicalCandles, page.candles),
    oldestTradeId: page.oldestTradeId ?? slice.oldestTradeId,
    hasMore: page.hasMore,
  };
}

export function setLiveEdge(slice: ChartMintSlice, atEdge: boolean): ChartMintSlice {
  if (atEdge === slice.isAtLiveEdge) return slice;
  if (atEdge) return flushLiveBuffer({ ...slice, isAtLiveEdge: true });
  return { ...slice, isAtLiveEdge: false };
}

export function syncMarkers(
  slice: ChartMintSlice,
  userTrades: UserTrade[],
): ChartMintSlice {
  const ver = userTradesVersion(userTrades);
  if (ver === slice.userTradesVersion) return slice;
  return {
    ...slice,
    userTradesVersion: ver,
    markersById: buildMarkers(userTrades, slice.tf),
  };
}

/** Visible candle series: historical + buffered patches when off live edge. */
export function visibleCandles(slice: ChartMintSlice): Candle[] {
  if (slice.isAtLiveEdge || !slice.liveBuffer.length) return slice.historicalCandles;
  let candles = slice.historicalCandles;
  for (const b of slice.liveBuffer) {
    candles = applyBundleToCandles(candles, b, slice.tf);
  }
  return candles;
}
