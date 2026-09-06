import { NextResponse } from "next/server";
import { bootDb } from "@/lib/db/client";
import { cached } from "@/lib/api/short-cache";
import { autoDemoRelaxEnabled, env } from "@/lib/env";
import { countPendingBuyDecisions } from "@/lib/db/repos/paper-trades";
import { readState } from "@/lib/circuit-breaker/state";
import { fetchHeartbeats } from "@/lib/runtime/worker-heartbeat-db";
import { getSolUsd, solPriceCacheSnapshot } from "@/lib/market/sol-usd";
import { fetchAutoSessionPositionsSnapshot } from "@/lib/auto/session-positions";
import {
  DEFAULT_PARAMS,
  fetchSessionActivityLog,
  fetchTodayLoss,
  getActiveSession,
  getLatestSession,
} from "@/lib/db/repos/auto-sessions";
import { fetchModeLiteSnapshot } from "@/lib/settings/mode-lite-snapshot";
import { refreshSignalModeOverride, signalModeStatus } from "@/lib/settings/signal-mode";
import {
  composePortfolio,
  filterImportantLogs,
  resolveSourceStatus,
  type TickerClosedPosition,
  type TickerPosition,
  type TickerResponse,
  type TickerSourceStatus,
} from "@/lib/auto/ticker-snapshot";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * The single live-data endpoint for /trade.
 *
 * Everything the screen shows comes from one response, so nothing on it can
 * disagree with anything else: hero totals are derived from the very rows the
 * position list renders (lib/auto/ticker-snapshot.ts), SOL/USD+AUD ride along
 * so the page never polls /api/market/sol-usd, and the log is pre-filtered so
 * skip noise never reaches the browser.
 *
 * Cached 1 s: the client polls at 1 s when positions are open, and the cache
 * dedupes concurrent tabs. The pump.fun mcap lookups underneath already have
 * their own 8 s TTL, so 1 s polling does not mean 1 s upstream calls.
 */
async function workerAlive(timeoutMs: number): Promise<boolean> {
  try {
    const beats = await fetchHeartbeats();
    const now = Date.now();
    return beats.some(
      (b) =>
        (b.name === "auto-trader" || b.name === "intelligence-commit" || b.name === "ingestor") &&
        now - new Date(b.lastBeat).getTime() < timeoutMs,
    );
  } catch {
    return false;
  }
}

async function buildTicker(): Promise<TickerResponse> {
  const e = env();
  const snapshotAt = Date.now();

  // Same cache key + TTL as /api/settings/mode-lite, so the two routes share one
  // snapshot and the 1 s ticker cadence never means 1 s mode/demo-account reads.
  const [active, latest, breaker, alive, modeLite] = await Promise.all([
    getActiveSession(),
    getLatestSession(),
    readState().catch(() => ({ state: "RUNNING" as const })),
    workerAlive(e.WORKER_HEARTBEAT_TIMEOUT_MS),
    cached("settings:mode-lite", 12_000, fetchModeLiteSnapshot),
    // The strategy override lives in the DB and is loaded per PROCESS. The web
    // tier only loaded it when someone hit /api/settings/signal-mode; without this
    // the ticker would report .env's SIGNAL_MODE while the worker trades the
    // override. Cached 5 s so the 1 s cadence does not become a 1 s query.
    cached("settings:signal-mode", 5_000, refreshSignalModeOverride),
  ]);
  const session = active ?? latest;
  const uiMode = modeLite.mode;

  const [snap, logsRaw, todayLoss, pendingBuys] = await Promise.all([
    // 60 = the snapshot's cap; closed rows for the Closed tab ride along in the same query.
    fetchAutoSessionPositionsSnapshot(60),
    session ? fetchSessionActivityLog(session.id, { limit: 60 }) : Promise.resolve([]),
    session ? fetchTodayLoss(session.id).catch(() => 0) : Promise.resolve(0),
    // Same 90 s window + relax flag the auto-trader itself uses for its queue.
    active ? countPendingBuyDecisions(90, { relaxAutoGate: autoDemoRelaxEnabled() }).catch(() => 0) : Promise.resolve(0),
  ]);

  const positions: TickerPosition[] = snap.open.map((p) => ({
    id: p.id,
    mint: p.mint,
    symbol: p.symbol,
    source: p.source,
    sizeSol: p.sizeSol,
    pnlSol: p.pnlSol,
    pctOfSize: p.pctOfSize,
    entryMcapUsd: p.entryMcapUsd,
    currentMcapUsd: p.currentMcapUsd,
    entryVSol: p.entryVSol,
    currentVSol: p.currentVSol,
    openedAt: p.openedAt,
  }));

  const closedPositions: TickerClosedPosition[] = snap.closed.map((p) => ({
    id: p.id,
    mint: p.mint,
    symbol: p.symbol,
    source: p.source,
    sizeSol: p.sizeSol,
    pnlSol: p.pnlSol,
    exitReason: p.exitReason,
    openedAt: p.openedAt,
    closedAt: p.closedAt,
  }));

  // availableSol is cash, not P&L, so reading it from the demo account cannot
  // conflict with the position-derived numbers. Real mode: unknown here.
  const portfolio = composePortfolio(
    positions,
    snap.stats.realizedPnlSol,
    uiMode === "demo" ? modeLite.demo.balanceSol : null,
  );

  // Keep the SOL/USD+AUD cache warm in THIS process (60 s TTL inside); without
  // this the web tier would serve the 150/230 fallbacks forever.
  void getSolUsd().catch(() => undefined);
  const params = session?.params ?? DEFAULT_PARAMS;
  const sol = solPriceCacheSnapshot();

  return {
    serverAt: Date.now(),
    snapshotAt,
    stale: false,
    sourceStatus: resolveSourceStatus({
      hasSession: !!session,
      sessionActive: !!active,
      breaker: breaker.state,
      workerAlive: alive,
      snapshotAgeMs: 0,
    }),
    session: session
      ? {
          id: session.id,
          mode: session.mode,
          status: session.status,
          startedAt: session.startedAt,
          stoppedAt: session.stoppedAt,
          stopReason: session.stopReason,
        }
      : null,
    status: { breaker: breaker.state, workerAlive: alive, uiMode },
    // The mode-lite snapshot is a 12 s cache; this route reads the session and
    // positions uncached, so it must not forward a staler activeSession than it
    // knows itself (the nav's "Bot running" indicator hydrates from this).
    mode: { ...modeLite, activeSession: !!active || positions.length > 0 },
    signalMode: signalModeStatus(),
    solUsd: sol.usd,
    solAud: sol.aud,
    portfolio,
    positions,
    closedPositions,
    bot: {
      running: !!active,
      slotsFull: !!active && positions.length >= Math.min(params.maxConcurrent, e.PAPER_MAX_OPEN_POSITIONS),
      pendingBuySignals: pendingBuys,
      sizeSol: params.sizeSol,
      maxDailyLossSol: params.maxDailyLossSol,
      maxConcurrent: params.maxConcurrent,
      effectiveMaxConcurrent: Math.min(params.maxConcurrent, e.PAPER_MAX_OPEN_POSITIONS),
      maxConcurrentCeiling: e.PAPER_MAX_OPEN_POSITIONS,
      takeProfitPct: params.takeProfitPct,
      stopLossPct: params.stopLossPct,
      maxHoldMinutes: params.maxHoldMinutes,
      // Resolved the same way the worker resolves them (auto-trader handleExits).
      stagnationMinutes: params.stagnationMinutes ?? params.maxHoldMinutes * 0.4,
      stagnationMaxPeakPct: params.stagnationMaxPeakPct ?? params.trailingArmPct ?? 0,
      todayLossSol: todayLoss,
      smartMoney: {
        require: params.requireSmartMoney ?? "off",
        boost: params.smartMoneyBoost === true,
      },
      liveExecution: e.LIVE_EXECUTION,
      liveDryRun: e.LIVE_DRY_RUN,
      defaults: {
        sizeSol: DEFAULT_PARAMS.sizeSol,
        maxDailyLossSol: DEFAULT_PARAMS.maxDailyLossSol,
        maxConcurrent: Math.min(DEFAULT_PARAMS.maxConcurrent, e.PAPER_MAX_OPEN_POSITIONS),
      },
    },
    logs: filterImportantLogs(logsRaw, 20),
  };
}

export async function GET() {
  await bootDb();
  try {
    const t = await cached("ticker", 1_000, buildTicker);
    // Staleness is judged at serve time, not build time, so a cache hit that has
    // aged past the threshold is reported as such rather than as current.
    const serverAt = Date.now();
    const ageMs = serverAt - t.snapshotAt;
    const stale = ageMs > 5_000;
    return NextResponse.json({
      ...t,
      serverAt,
      stale,
      sourceStatus: stale && t.sourceStatus === "live" ? "stale" : t.sourceStatus,
    });
  } catch (err) {
    return NextResponse.json(
      {
        serverAt: Date.now(),
        snapshotAt: null,
        stale: true,
        sourceStatus: "error" satisfies TickerSourceStatus,
        error: String(err instanceof Error ? err.message : err),
      },
      { status: 503 },
    );
  }
}
