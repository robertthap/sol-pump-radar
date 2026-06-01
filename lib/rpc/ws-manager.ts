import "server-only";
import WebSocket, { type RawData } from "ws";
import { logger } from "@/lib/log";
import { getIngestorStats } from "./stats";

const log = logger("ws");

export type LogsNotification = {
  signature: string;
  slot: number;
  err: unknown;
  logs: string[];
};

type WsState =
  | { kind: "idle" }
  | { kind: "connecting"; ws: WebSocket; openedAt: number }
  | { kind: "open"; ws: WebSocket; subId: number | null; openedAt: number };

export class WsLogsSubscriber {
  private state: WsState = { kind: "idle" };
  private nextId = 1;
  private endpointIndex = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private consecutiveFailures = 0;

  constructor(
    private readonly endpoints: string[],
    private readonly mention: string,
    private readonly onLogs: (n: LogsNotification) => void,
  ) {}

  start() {
    if (!this.endpoints.length) {
      log.error("no RPC WSS endpoints configured");
      const s = getIngestorStats();
      s.connState = "error";
      s.lastError = "no endpoints";
      return;
    }
    this.connect();
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.state.kind !== "idle") {
      try {
        this.state.ws.close();
      } catch {}
    }
    this.state = { kind: "idle" };
    const s = getIngestorStats();
    s.connState = "closed";
  }

  private endpoint(): string {
    return this.endpoints[this.endpointIndex % this.endpoints.length]!;
  }

  private connect() {
    if (this.stopped) return;
    const url = this.endpoint();
    const stats = getIngestorStats();
    stats.endpoint = url;
    stats.connState = "connecting";
    log.info("connecting", { url });

    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      this.scheduleReconnect("construct failed: " + String(e));
      return;
    }
    this.state = { kind: "connecting", ws, openedAt: Date.now() };

    ws.on("open", () => this.onOpen(ws));
    ws.on("message", (data) => this.onMessage(data));
    ws.on("error", (err) => {
      stats.lastError = String(err);
      log.warn("ws error", { err: String(err) });
    });
    ws.on("close", (code, reason) => this.onClose(code, reason?.toString()));
  }

  private onOpen(ws: WebSocket) {
    const stats = getIngestorStats();
    stats.connState = "open";
    stats.connectedAt = Date.now();
    this.consecutiveFailures = 0;
    log.info("open", { endpoint: stats.endpoint });

    const req = {
      jsonrpc: "2.0",
      id: this.nextId++,
      method: "logsSubscribe",
      params: [{ mentions: [this.mention] }, { commitment: "confirmed" }],
    };
    try {
      ws.send(JSON.stringify(req));
    } catch (e) {
      log.warn("send subscribe failed", { err: String(e) });
    }
    this.state = { kind: "open", ws, subId: null, openedAt: Date.now() };

    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      try {
        ws.ping();
      } catch {}
    }, 30_000);
  }

  private onMessage(raw: RawData) {
    let msg: { method?: string; id?: number; result?: unknown; params?: { result?: unknown } };
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.method === "logsNotification") {
      const r = (msg.params?.result as { value?: LogsNotification }) ?? null;
      if (r && r.value) this.onLogs(r.value);
      return;
    }
    if (typeof msg.id === "number" && typeof msg.result === "number") {
      if (this.state.kind === "open") {
        this.state.subId = msg.result;
      }
      const stats = getIngestorStats();
      stats.connState = "subscribed";
      log.info("subscribed", { subId: msg.result });
      return;
    }
  }

  private onClose(code: number, reason: string | undefined) {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    const stats = getIngestorStats();
    stats.connState = "closed";
    const lived = this.state.kind === "idle" ? 0 : Date.now() - this.state.openedAt;
    log.warn("closed", { code, reason, livedMs: lived });
    this.state = { kind: "idle" };
    if (lived < 5_000) this.consecutiveFailures++;
    else this.consecutiveFailures = 0;
    this.endpointIndex = (this.endpointIndex + 1) % this.endpoints.length;
    this.scheduleReconnect(reason ?? `closed ${code}`);
  }

  private scheduleReconnect(reason: string) {
    if (this.stopped) return;
    const stats = getIngestorStats();
    stats.reconnects++;
    stats.lastError = reason;
    const base = Math.min(60_000, 1000 * 2 ** Math.min(this.consecutiveFailures, 6));
    const jitter = Math.random() * 1000;
    const delay = base + jitter;
    log.info("reconnect scheduled", { delayMs: Math.round(delay), reason });
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }
}
