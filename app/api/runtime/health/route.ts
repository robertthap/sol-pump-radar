import { NextResponse } from "next/server";
import { bootDb } from "@/lib/db/client";
import { env } from "@/lib/env";
import { fetchHeartbeats } from "@/lib/runtime/worker-heartbeat-db";
import { getUiTradingMode } from "@/lib/db/repos/trading-mode";
import {
  fetchIngestHealthMetrics,
  fetchLatestRuntimeSnapshotPayload,
  fetchRuntimeSnapshotSparkline,
} from "@/lib/runtime/health-read";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const AUTO_TRADER_STALE_MS = 15_000;

// Background workers tick infrequently — don't flag them STALE for ticking slowly.
// staleLimit = cadence × 2.5 (tolerates a missed run), floored at the global timeout.
// Workers absent here use the global timeout (correct for the fast loops).
const WORKER_CADENCE_MS: Record<string, number> = {
  "missed-winner-scan": 60 * 60_000, // hourly
  retention: 60 * 60_000, // hourly
  "chart-aggregator": 2_000,
  "chart-dex-quotes": 3_000,
  "chart-reconcile": 30_000,
};

// These beat once at startup and intentionally never tick again (orchestrator = boot
// coordinator; continuation-learner = profit-mode stub). Their presence means they
// booted fine, so never flag them STALE — but they don't count toward worker liveness.
const BOOT_ONLY = new Set(["orchestrator", "continuation-learner"]);

/**
 * Single endpoint the UI uses to render the runtime health panel.
 * Reads truth from Postgres only — no filesystem, no in-memory state.
 */
export async function GET() {
  await bootDb();
  const e = env();
  const now = Date.now();
  const heartbeatTimeoutMs = e.WORKER_HEARTBEAT_TIMEOUT_MS;

  let heartbeats: Array<{
    name: string;
    lastBeat: Date;
    tickMs: number | null;
    staleMs: number;
    healthy: boolean;
    critical: boolean;
  }> = [];
  try {
    const rows = await fetchHeartbeats();
    heartbeats = rows.map((r) => {
      const staleMs = now - new Date(r.lastBeat).getTime();
      const isAutoTrader = r.name === "auto-trader";
      const cadence = WORKER_CADENCE_MS[r.name];
      const staleLimit = isAutoTrader
        ? AUTO_TRADER_STALE_MS
        : cadence != null
          ? Math.max(heartbeatTimeoutMs, cadence * 2.5)
          : heartbeatTimeoutMs;
      return {
        name: r.name,
        lastBeat: r.lastBeat,
        tickMs: r.tickMs,
        staleMs,
        healthy: BOOT_ONLY.has(r.name) ? true : staleMs < staleLimit,
        critical: isAutoTrader,
      };
    });

    const autoTraderRow = heartbeats.find((h) => h.name === "auto-trader");
    if (!autoTraderRow) {
      heartbeats.push({
        name: "auto-trader",
        lastBeat: new Date(0),
        tickMs: null,
        staleMs: now,
        healthy: false,
        critical: true,
      });
    }
  } catch {
    /* table may not yet exist before first worker boot */
  }

  const ingestMetrics = await fetchIngestHealthMetrics();
  const lastEventMs = ingestMetrics.lastEventAt
    ? now - new Date(ingestMetrics.lastEventAt).getTime()
    : null;
  const ingestStaleSec = lastEventMs != null ? Math.round(lastEventMs / 1000) : null;
  // Liveness comes from the ticking workers only — a boot-only worker (always "healthy")
  // must not mask a dead process where every real loop has gone stale.
  const workerAlive = heartbeats.some((h) => h.healthy && !BOOT_ONLY.has(h.name));

  const snapshot = await fetchLatestRuntimeSnapshotPayload();
  const rpc = snapshot?.rpc as
    | {
        rpcScore?: number;
        rpcIssues?: string[];
        reconnectCount?: number;
        lastMessageAgeSec?: number;
        latencyMs?: number | null;
      }
    | undefined;

  const snapshotSparkline = await fetchRuntimeSnapshotSparkline();

  let uiTradingMode: "demo" | "real" | null = null;
  try {
    uiTradingMode = await getUiTradingMode();
  } catch {
    /* optional */
  }

  return NextResponse.json({
    runtimeProfile: e.RUNTIME_PROFILE,
    workersExpected: e.WORKERS === "on",
    workerAlive,
    liveExecution: e.LIVE_EXECUTION,
    liveDryRun: e.LIVE_DRY_RUN,
    traderMode: e.TRADER_MODE,
    uiTradingMode,
    circuitBreaker: (snapshot?.circuitBreaker as string | undefined) ?? null,
    heartbeats,
    ingest: {
      lastEventAt: ingestMetrics.lastEventAt,
      eventsLast60s: ingestMetrics.eventsLast60s,
      ingestStaleSec,
      drops1h: ingestMetrics.drops1h,
      dropBatches1h: ingestMetrics.dropBatches1h,
      maxQueue: e.MAX_INGEST_QUEUE,
    },
    lastDomainEventAt: ingestMetrics.lastDomainEventAt,
    heartbeatTimeoutMs,
    snapshot,
    snapshotSparkline,
    rpc: rpc ?? null,
    chart: {
      wsPort: e.CHART_WS_PORT,
      wsUrl: e.NEXT_PUBLIC_CHART_WS_URL,
    },
    now: new Date().toISOString(),
  });
}
