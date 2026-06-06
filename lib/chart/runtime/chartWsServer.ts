import "server-only";

import WebSocket, { WebSocketServer } from "ws";
import { env } from "@/lib/env";
import { logger } from "@/lib/log";
import type { ChartTimeframe } from "@/lib/chart/types";
import type { WsEnvelope } from "@/lib/chart/realtime/eventRouter";
import { envelope } from "@/lib/chart/realtime/eventRouter";
import {
  buildSyncSnapshot,
  initChartRuntime,
  markChartSubscribed,
  tailReplayBundles,
} from "@/lib/chart/runtime/chartRuntime";

const log = logger("chart-ws");

type Client = {
  ws: WebSocket;
  mint: string;
  tf: ChartTimeframe;
  lastTradeId: string;
  epoch: number;
};

const clients = new Set<Client>();
let wss: WebSocketServer | null = null;

export function getChartSubscribedMints(): string[] {
  return [...new Set([...clients].map((c) => c.mint))];
}

export function broadcastChart(mint: string, msg: WsEnvelope): void {
  const raw = JSON.stringify(msg);
  for (const c of clients) {
    if (c.mint !== mint) continue;
    if (c.ws.readyState === WebSocket.OPEN) c.ws.send(raw);
  }
}

export function startChartWsServer(): () => void {
  initChartRuntime({ onBroadcast: broadcastChart });

  const port = env().CHART_WS_PORT;
  wss = new WebSocketServer({ port, path: "/chart" });
  log.info("chart ws listening", { port });

  wss.on("connection", (ws, req) => {
    const url = new URL(req.url ?? "/chart", "http://127.0.0.1");
    const mint = url.searchParams.get("mint") ?? "";
    const tf = (url.searchParams.get("tf") ?? "1m") as ChartTimeframe;
    if (!mint || mint.length < 32) {
      ws.close(1008, "invalid mint");
      return;
    }

    const client: Client = {
      ws,
      mint,
      tf,
      lastTradeId: "0",
      epoch: 1,
    };
    clients.add(client);
    markChartSubscribed(mint, true);

    ws.on("message", (data) => {
      void handleMessage(client, String(data));
    });

    ws.on("close", () => {
      clients.delete(client);
      if (![...clients].some((c) => c.mint === mint)) {
        markChartSubscribed(mint, false);
      }
    });
  });

  return () => {
    for (const c of clients) c.ws.close();
    clients.clear();
    wss?.close();
    wss = null;
  };
}

async function handleMessage(client: Client, raw: string): Promise<void> {
  let msg: { type?: string; lastTradeId?: string; epoch?: number; tf?: ChartTimeframe };
  try {
    msg = JSON.parse(raw) as typeof msg;
  } catch {
    return;
  }

  if (msg.type === "CLIENT_HELLO") {
    client.lastTradeId = msg.lastTradeId ?? "0";
    client.epoch = msg.epoch ?? 1;
    if (msg.tf) client.tf = msg.tf;
    const snap = await buildSyncSnapshot(client.mint, client.tf);
    client.epoch = snap.epoch;
    client.lastTradeId = snap.lastTradeId;
    const envMsg = envelope("SYNC_SNAPSHOT", {
      mint: client.mint,
      epoch: snap.epoch,
      seq: 0,
      lastTradeId: snap.lastTradeId,
    }, snap);
    client.ws.send(JSON.stringify(envMsg));

    const tail = await tailReplayBundles(client.mint, snap.lastTradeId);
    for (const b of tail) {
      client.ws.send(
        JSON.stringify(
          envelope("COMMIT_BUNDLE", {
            mint: client.mint,
            epoch: b.epoch,
            seq: b.seq,
            lastTradeId: b.lastTradeId,
          }, b),
        ),
      );
    }
    return;
  }

  if (msg.type === "RESYNC_REQUEST") {
    const snap = await buildSyncSnapshot(client.mint, client.tf);
    client.epoch = snap.epoch;
    client.lastTradeId = snap.lastTradeId;
    client.ws.send(
      JSON.stringify(
        envelope("SYNC_SNAPSHOT", {
          mint: client.mint,
          epoch: snap.epoch,
          seq: 0,
          lastTradeId: snap.lastTradeId,
        }, snap),
      ),
    );
    const tail = await tailReplayBundles(client.mint, snap.lastTradeId);
    for (const b of tail) {
      client.ws.send(
        JSON.stringify(
          envelope("COMMIT_BUNDLE", {
            mint: client.mint,
            epoch: b.epoch,
            seq: b.seq,
            lastTradeId: b.lastTradeId,
          }, b),
        ),
      );
    }
    return;
  }

  if (msg.type === "CLIENT_ACK" && msg.lastTradeId) {
    client.lastTradeId = msg.lastTradeId;
  }
}
