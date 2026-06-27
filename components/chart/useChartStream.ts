"use client";

/**
 * Playbook §7 — REST bootstrap + WS COMMIT_BUNDLE stream with dual buffer.
 */

import { useCallback, useEffect, useReducer, useRef } from "react";
import type {
  ChartTimeframe,
  CommitBundle,
  SyncSnapshot,
  UserTrade,
} from "@/lib/chart/types";
import { CANDLE_PAGE_SIZE } from "@/lib/chart/constants";
import type { WsEnvelope } from "@/lib/chart/realtime/eventRouter";
import { hasGap, shouldAcceptSeq } from "@/lib/chart/realtime/eventRouter";
import {
  applyCommitBundle,
  applySyncSnapshot,
  createInitialSlice,
  prependHistoricalPage,
  setHistoricalPage,
  setLiveEdge,
  syncMarkers,
  visibleCandles,
  type ChartMintSlice,
} from "@/components/chart/chartStore";

type CandlePage = { candles: SyncSnapshot["candles"]; oldestTradeId: string | null; hasMore: boolean };

async function fetchCandlePage(mint: string, tf: ChartTimeframe, beforeId?: string): Promise<CandlePage> {
  const q = new URLSearchParams({ tf, limit: String(CANDLE_PAGE_SIZE) });
  if (beforeId) q.set("beforeId", beforeId);
  const r = await fetch(`/api/tokens/${encodeURIComponent(mint)}/candles?${q}`, { cache: "no-store" });
  if (!r.ok) throw new Error(`candles ${r.status}`);
  return (await r.json()) as CandlePage;
}

async function fetchChartState(mint: string, tf: ChartTimeframe): Promise<SyncSnapshot & { lastSeq?: number }> {
  const r = await fetch(`/api/tokens/${encodeURIComponent(mint)}/chart-state?tf=${tf}`, { cache: "no-store" });
  if (!r.ok) throw new Error(`chart-state ${r.status}`);
  return (await r.json()) as SyncSnapshot & { lastSeq?: number };
}

function wsBaseUrl(): string {
  return process.env.NEXT_PUBLIC_CHART_WS_URL ?? "ws://127.0.0.1:8788/chart";
}

function chartWsUrl(mint: string, tf: ChartTimeframe): string {
  const u = new URL(wsBaseUrl());
  u.searchParams.set("mint", mint);
  u.searchParams.set("tf", tf);
  return u.toString();
}

type Action =
  | { type: "reset"; mint: string; tf: ChartTimeframe }
  | { type: "page"; page: CandlePage }
  | { type: "prepend"; page: CandlePage }
  | { type: "snapshot"; snap: SyncSnapshot }
  | { type: "bundle"; bundle: CommitBundle }
  | { type: "regime"; regime: SyncSnapshot["regime"]; graduationAt?: number | null }
  | { type: "ws"; connected: boolean }
  | { type: "liveEdge"; atEdge: boolean }
  | { type: "markers"; trades: UserTrade[] };

function reducer(state: ChartMintSlice, action: Action): ChartMintSlice {
  switch (action.type) {
    case "reset":
      return createInitialSlice(action.mint, action.tf);
    case "page":
      return setHistoricalPage(state, action.page);
    case "prepend":
      return prependHistoricalPage(state, action.page);
    case "snapshot":
      return applySyncSnapshot(state, action.snap);
    case "bundle":
      return applyCommitBundle(state, action.bundle);
    case "regime":
      return {
        ...state,
        regime: action.regime,
        graduationAt: action.graduationAt ?? state.graduationAt,
      };
    case "ws":
      return { ...state, wsConnected: action.connected };
    case "liveEdge":
      return setLiveEdge(state, action.atEdge);
    case "markers":
      return syncMarkers(state, action.trades);
    default:
      return state;
  }
}

export function useChartStream(mint: string, tf: ChartTimeframe, userTrades: UserTrade[] = []) {
  const [slice, dispatch] = useReducer(reducer, createInitialSlice(mint, tf));
  const sliceRef = useRef(slice);
  sliceRef.current = slice;

  const wsRef = useRef<WebSocket | null>(null);
  const loadingOlderRef = useRef(false);

  useEffect(() => {
    dispatch({ type: "markers", trades: userTrades });
  }, [userTrades, tf]);

  // REST bootstrap + WS lifecycle (playbook §7 mount sequence).
  useEffect(() => {
    if (!mint || mint.length < 32) return;
    let alive = true;
    dispatch({ type: "reset", mint, tf });

    const connectWs = (watermark: { lastTradeId: string; epoch: number }) => {
      if (!alive) return;
      wsRef.current?.close();
      const ws = new WebSocket(chartWsUrl(mint, tf));
      wsRef.current = ws;

      ws.onopen = () => {
        if (!alive) return;
        dispatch({ type: "ws", connected: true });
        ws.send(
          JSON.stringify({
            type: "CLIENT_HELLO",
            lastTradeId: watermark.lastTradeId,
            epoch: watermark.epoch,
            tf,
          }),
        );
      };

      ws.onmessage = (ev) => {
        if (!alive) return;
        let msg: WsEnvelope;
        try {
          msg = JSON.parse(String(ev.data)) as WsEnvelope;
        } catch {
          return;
        }
        if (msg.mint !== mint) return;

        const cur = sliceRef.current;

        if (msg.type === "SYNC_SNAPSHOT" && msg.payload) {
          dispatch({ type: "snapshot", snap: msg.payload as SyncSnapshot });
          return;
        }

        if (msg.type === "REGIME_SWITCH" && msg.payload && "to" in (msg.payload as object)) {
          const p = msg.payload as { to: SyncSnapshot["regime"]; graduationAt?: number };
          dispatch({
            type: "regime",
            regime: p.to,
            graduationAt: p.graduationAt ?? null,
          });
          return;
        }

        const bundleTypes = new Set(["COMMIT_BUNDLE", "RECONCILE_PATCH"]);
        if (bundleTypes.has(msg.type) && msg.payload) {
          const bundle = msg.payload as CommitBundle;
          const firstId = bundle.trades[0]?.tradeId;
          if (
            hasGap(cur.lastTradeId, bundle.lastTradeId, firstId) &&
            cur.lastTradeId !== "0"
          ) {
            ws.send(JSON.stringify({ type: "RESYNC_REQUEST", lastTradeId: cur.lastTradeId, epoch: cur.chartSeq.epoch }));
            return;
          }
          if (
            !shouldAcceptSeq(
              { ...cur.chartSeq, lastTradeId: cur.lastTradeId },
              { epoch: msg.epoch, seq: msg.seq, lastTradeId: msg.lastTradeId },
            )
          ) {
            return;
          }
          dispatch({ type: "bundle", bundle });
          if (sliceRef.current.isAtLiveEdge) {
            ws.send(JSON.stringify({ type: "CLIENT_ACK", lastTradeId: bundle.lastTradeId }));
          }
        }
      };

      ws.onclose = () => {
        if (!alive) return;
        dispatch({ type: "ws", connected: false });
        setTimeout(() => {
          if (alive) connectWs(sliceRef.current.chartSeq.epoch ? { lastTradeId: sliceRef.current.lastTradeId, epoch: sliceRef.current.chartSeq.epoch } : watermark);
        }, 2000);
      };

      ws.onerror = () => ws.close();
    };

    void (async () => {
      try {
        const page = await fetchCandlePage(mint, tf);
        if (!alive) return;
        dispatch({ type: "page", page });

        const state = await fetchChartState(mint, tf);
        if (!alive) return;
        dispatch({ type: "snapshot", snap: state });

        connectWs({ lastTradeId: state.lastTradeId, epoch: state.epoch });
      } catch {
        if (alive) dispatch({ type: "page", page: { candles: [], oldestTradeId: null, hasMore: false } });
      }
    })();

    return () => {
      alive = false;
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [mint, tf]);

  // Keep the chart fresh with periodic REST snapshots. The WS (worker) is the fast
  // path (instant trade pushes); /chart-state (web process, always-current Gecko
  // data) is the safety net that guarantees the chart stays accurate even if the WS
  // is down or stale. When the WS IS connected it already pushes fresh data, so the
  // poll backs off to 20s (just a correctness backstop) instead of 6s — cutting
  // redundant load that competes for the Helius budget. Skipped while tab hidden.
  useEffect(() => {
    if (!mint || mint.length < 32) return;
    let alive = true;
    const intervalMs = slice.wsConnected ? 20000 : 6000;
    const id = setInterval(async () => {
      if (typeof document !== "undefined" && document.hidden) return;
      try {
        const state = await fetchChartState(mint, tf);
        if (alive) dispatch({ type: "snapshot", snap: state });
      } catch {
        /* ignore poll error */
      }
    }, intervalMs);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [mint, tf, slice.wsConnected]);

  const setAtLiveEdge = useCallback((atEdge: boolean) => {
    dispatch({ type: "liveEdge", atEdge });
  }, []);

  const loadOlder = useCallback(async (): Promise<number> => {
    if (loadingOlderRef.current) return 0;
    const { oldestTradeId, hasMore } = sliceRef.current;
    if (!hasMore || !oldestTradeId) return 0;
    loadingOlderRef.current = true;
    try {
      const page = await fetchCandlePage(mint, tf, oldestTradeId);
      if (!page.candles.length) return 0;
      dispatch({ type: "prepend", page });
      return page.candles.length;
    } catch {
      return 0;
    } finally {
      loadingOlderRef.current = false;
    }
  }, [mint, tf]);

  const candles = visibleCandles(slice);

  return {
    candles,
    marketCap: slice.marketCap,
    regime: slice.regime,
    graduationAt: slice.graduationAt,
    loading: slice.loading,
    live: slice.wsConnected,
    oldestTradeId: slice.oldestTradeId,
    hasMore: slice.hasMore,
    markersById: slice.markersById,
    loadOlder,
    setAtLiveEdge,
    bufferedCount: slice.liveBuffer.length,
  };
}
