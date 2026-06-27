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

/**
 * T1.1 — emitted after a successful re-subscribe following a real disconnect.
 * The ingestor uses this to compute the gap window and kick gap-recovery.
 * `lastSlot`/`lastSig` are the last successfully observed values from BEFORE
 * the disconnect. Not emitted on the very first connection (no gap exists yet).
 */
export type ReconnectInfo = {
  lastSlot: number;
  lastSig: string | null;
  lastTs: Date;
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
  // T1.1 — last-seen high-water-mark. Updated on every notification; sampled
  // on disconnect; reported via onReconnect after a successful re-subscribe.
  private lastSlot = 0;
  private lastSig: string | null = null;
  private lastTs: Date = new Date();
  // Snapshot of lastSlot/lastSig at the moment of the most recent disconnect,
  // so the post-reconnect callback reports the right pre-gap state even if
  // some no-op `connect()` calls happen in between.
  private gapAnchor: ReconnectInfo | null = null;
  // True once we've successfully opened at least once. Suppresses the
  // first-connect "reconnect" emission (no gap exists yet).
  private hasBeenOpen = false;

  constructor(
    private readonly endpoints: string[],
    private readonly mention: string,
    private readonly onLogs: (n: LogsNotification) => void,
    private readonly onReconnect?: (info: ReconnectInfo) => void,
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
      if (r && r.value) {
        // T1.1 — track HWM for gap detection. Slot may decrease across
        // independent forks in rare cases; keep max-seen as the watermark.
        if (r.value.slot > this.lastSlot) {
          this.lastSlot = r.value.slot;
          this.lastSig = r.value.signature ?? null;
          this.lastTs = new Date();
        }
        this.onLogs(r.value);
      }
      return;
    }
    if (typeof msg.id === "number" && typeof msg.result === "number") {
      if (this.state.kind === "open") {
        this.state.subId = msg.result;
      }
      const stats = getIngestorStats();
      stats.connState = "subscribed";
      log.info("subscribed", { subId: msg.result });
      // T1.1 — emit reconnect AFTER subscription is confirmed (so subsequent
      // notifications start arriving). Skip the very first connect (no gap).
      if (this.hasBeenOpen && this.gapAnchor && this.onReconnect) {
        const info = this.gapAnchor;
        this.gapAnchor = null;
        try { this.onReconnect(info); } catch (e) {
          log.warn("onReconnect handler threw", { err: String(e) });
        }
      }
      this.hasBeenOpen = true;
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
    // T1.1 — snapshot the HWM at moment of disconnect, so the post-reconnect
    // callback can use it to compute the gap window. Don't overwrite an
    // existing anchor (multiple rapid reconnects all share the same gap).
    if (this.hasBeenOpen && !this.gapAnchor && this.lastSlot > 0) {
      this.gapAnchor = { lastSlot: this.lastSlot, lastSig: this.lastSig, lastTs: this.lastTs };
    }
    if (lived < 5_000) this.consecutiveFailures++;
    else this.consecutiveFailures = 0;
    this.endpointIndex = (this.endpointIndex + 1) % this.endpoints.length;
    this.scheduleReconnect(reason ?? `closed ${code}`);
  }

  /** T1.1 — current high-water-mark for cold-boot watermark seeding. */
  getHighWaterMark(): ReconnectInfo {
    return { lastSlot: this.lastSlot, lastSig: this.lastSig, lastTs: this.lastTs };
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
