"use client";

import { useEffect, useRef } from "react";
import type { ChartTimeframe, CommitBundle, SyncSnapshot, RegimeSwitchPayload } from "@/lib/chart/types";
import type { WsEnvelope } from "@/lib/chart/realtime/eventRouter";
import { useChartStore } from "@/components/chart/chartStore";

function wsUrl(mint: string, tf: ChartTimeframe): string {
  const base = process.env.NEXT_PUBLIC_CHART_WS_URL ?? "ws://127.0.0.1:8788/chart";
  const u = new URL(base);
  u.searchParams.set("mint", mint);
  u.searchParams.set("tf", tf);
  return u.toString();
}

export function useChartStream(mint: string, tf: ChartTimeframe) {
  const wsRef = useRef<WebSocket | null>(null);
  const hadConnectRef = useRef(false);

  const chartSeq = useChartStore((s) => s.slices[mint]?.chartSeq ?? { epoch: 1, seq: 0, lastTradeId: "0" });
  const resyncFlag = useChartStore((s) => s.slices[mint]?.resyncFlag ?? 0);

  useEffect(() => {
    if (!mint || mint.length < 32) return;

    let alive = true;
    let retryMs = 500;

    const connect = () => {
      if (!alive) return;
      const ws = new WebSocket(wsUrl(mint, tf));
      wsRef.current = ws;

      ws.onopen = () => {
        retryMs = 500;
        const api = useChartStore.getState();
        api.setWsConnected(mint, true);
        if (hadConnectRef.current) {
          api.requestResync(mint);
        }
        hadConnectRef.current = true;
        const seq = api.slices[mint]?.chartSeq ?? { epoch: 1, seq: 0, lastTradeId: "0" };
        const hello = {
          type: "CLIENT_HELLO",
          lastTradeId: seq.lastTradeId,
          epoch: seq.epoch,
          tf,
        };
        ws.send(JSON.stringify(hello));
      };

      ws.onerror = () => useChartStore.getState().setWsConnected(mint, false);

      ws.onmessage = (ev) => {
        let msg: WsEnvelope;
        try {
          msg = JSON.parse(String(ev.data)) as WsEnvelope;
        } catch {
          return;
        }
        const api = useChartStore.getState();
        if (msg.type === "SYNC_SNAPSHOT" && msg.payload) {
          const snap = msg.payload as SyncSnapshot;
          api.applySnapshot(mint, {
            candles: snap.candles,
            marketCap: snap.marketCap,
            epoch: snap.epoch,
            lastTradeId: snap.lastTradeId,
            regime: snap.regime,
          });
          return;
        }
        if (msg.type === "REGIME_SWITCH" && msg.payload) {
          const rs = msg.payload as RegimeSwitchPayload;
          api.setRegime(mint, rs.to);
          return;
        }
        if (msg.type === "COMMIT_BUNDLE" || msg.type === "RECONCILE_PATCH") {
          api.applyBundle(mint, msg.payload as CommitBundle);
        }
      };

      ws.onclose = () => {
        useChartStore.getState().setWsConnected(mint, false);
        if (!alive) return;
        setTimeout(connect, retryMs);
        retryMs = Math.min(retryMs * 2, 8000);
      };
    };

    connect();
    return () => {
      alive = false;
      hadConnectRef.current = false;
      useChartStore.getState().setWsConnected(mint, false);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [mint, tf]);

  useEffect(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "RESYNC_REQUEST" }));
  }, [resyncFlag]);

  useEffect(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "CLIENT_ACK", lastTradeId: chartSeq.lastTradeId }));
  }, [chartSeq.lastTradeId]);
}
