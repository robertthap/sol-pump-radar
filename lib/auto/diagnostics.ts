import "server-only";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { autoDemoRelaxEnabled, env, getEffectiveSignalMode, isProfitSignalMode } from "@/lib/env";
import { readState } from "@/lib/circuit-breaker/state";
import {
  getActiveSession,
  type AutoSessionDto,
} from "@/lib/db/repos/auto-sessions";
import {
  countPendingBuyDecisions,
  fetchOpenOwnershipCounts,
} from "@/lib/db/repos/paper-trades";
import { fetchMeasurementCounts } from "@/lib/db/repos/measurement";
import { openGapCount } from "@/lib/db/repos/ingest-gaps";
import { latestDrift } from "@/lib/workers/drift-monitor";
import { fetchContinuationUniverseStats } from "@/lib/db/repos/continuation-candidates";
import { getWorkerHeartbeats } from "@/lib/workers/heartbeat";
import { solUsdFreshness } from "@/lib/market/sol-usd";

export type AutoDiagnostics = {
  workersExpected: boolean;
  workersRunning: boolean;
  session: AutoSessionDto | null;
  pendingBuy90s: number;
  buyDecisions1h: number;
  skippedLast1h: Array<{ reason: string; count: number }>;
  circuitBreakerState: string;
  signalMode: string;
  riskPreset: string;
  lastTickAt: string | null;
  tradesOpened: number;
  hint: string | null;
  continuationUniverse?: {
    total: number;
    alert_ready: number;
    last_updated: string | null;
  };
  workerHeartbeats?: Record<string, number>;
  /** P2.2 — auto paper entries in the last 30 minutes (Option A frequency check). */
  autoPaperOpens30m: number;
  /** Bundle/mechanical bypass in demo only — entry filter is always qualifyEntry (Option A). */
  autoDemoRelax: boolean;
  entryFilter: "qualifyEntry";
  /** Set when BUY signals exist but Option A produced zero opens in 30m. */
  p22WarnOptionB: boolean;
  /** Phase 0 / issue #11 — explicit OPEN-position ownership vs the global cap. */
  openPositions: {
    total: number;
    ownedByActive: number;
    /** OPEN positions held by a STOPPED session — silently consume the global cap. */
    orphaned: number;
    untagged: number;
    globalCap: number;
  };
  /** Phase 0 / issue #4 — SOL/USD source health (a stale/fallback rate skews mcap). */
  solPrice: {
    usd: number;
    ageMs: number | null;
    fresh: boolean;
    usingFallback: boolean;
  };
  /** Phase 1 — measurement-backbone progress (watch this accumulate during the Phase 2 run). */
  measurement: {
    snapshotsUniverse: number;
    snapshotsControl: number;
    labelsComplete: number;
    labelsPending: number;
  };
  /** T1.1 — count of unrecovered WS coverage gaps. > 0 means some labels are
   *  currently blocked and the ingestor's recovery hasn't drained the queue.
   *  Persistent > 0 is a red flag (Helius issues / RPC budget exhaustion). */
  ingestGapsOpen: number;
  /** T1.3 — latest drift/meta-shift reading (null until the monitor has data). */
  drift: { maxPsi: number; metaShift: boolean; computedAt: string } | null;
};

export async function buildAutoDiagnostics(): Promise<AutoDiagnostics> {
  const session = await getActiveSession();
  const cb = await readState();
  const e = env();
  const workersExpected = e.WORKERS === "on";
  const lastTickAt = session?.stats?.lastTickAt ?? null;
  const tickAgeMs = lastTickAt ? Date.now() - new Date(lastTickAt).getTime() : null;
  const workersRunning =
    workersExpected && !!session && tickAgeMs != null && tickAgeMs < 30_000;

  const pendingBuy90s = await countPendingBuyDecisions(90, {
    relaxAutoGate: autoDemoRelaxEnabled(),
  });

  const countsRes = await getDb().execute(sql`
    SELECT
      COUNT(*) FILTER (
        WHERE action IN ('BUY_STRONG', 'BUY_MODERATE') AND ts > now() - interval '1 hour'
      )::int AS buy_1h,
      COUNT(*) FILTER (
        WHERE executed = 'skipped' AND executor_reason LIKE 'auto:%' AND ts > now() - interval '1 hour'
      )::int AS skipped_1h
    FROM decision_log
  `);
  const counts = (countsRes as unknown as {
    rows: Array<{ buy_1h: number; skipped_1h: number }>;
  }).rows[0];

  const skipRes = await getDb().execute(sql`
    SELECT COALESCE(executor_reason, 'unknown') AS reason, COUNT(*)::int AS n
    FROM decision_log
    WHERE executed = 'skipped'
      AND executor_reason LIKE 'auto:%'
      AND ts > now() - interval '1 hour'
    GROUP BY 1
    ORDER BY n DESC
    LIMIT 8
  `);
  const skippedLast1h = (
    skipRes as unknown as { rows: Array<{ reason: string; n: number }> }
  ).rows.map((r) => ({ reason: r.reason, count: r.n }));

  const ownership = await fetchOpenOwnershipCounts(session?.id ?? null);
  const globalCap = e.PAPER_MAX_OPEN_POSITIONS;
  const sol = solUsdFreshness();
  const measurement = await fetchMeasurementCounts().catch(() => ({
    snapshotsUniverse: 0,
    snapshotsControl: 0,
    labelsComplete: 0,
    labelsPending: 0,
  }));
  const ingestGapsOpen = await openGapCount().catch(() => 0);
  const drift = await latestDrift().catch(() => null);

  let hint: string | null = null;
  // Issue #11 — orphaned OPEN positions from stopped sessions can starve the
  // global concurrency cap even when the active session looks idle.
  if (ownership.orphaned > 0 && ownership.total >= globalCap) {
    hint = `${ownership.orphaned} OPEN position(s) from a stopped session are holding the global cap (${ownership.total}/${globalCap}). They free at max-hold; reset paper to clear immediately.`;
  }
  if (hint == null && session && (session.stats.tradesOpened ?? 0) === 0) {
    if (!workersExpected) {
      hint = "WORKERS=off in .env.local — set WORKERS=on and restart `pnpm dev` so the UI tracks the external worker.";
    } else if (!workersRunning) {
      hint = "No recent auto tick — make sure `pnpm worker` is running in a second terminal.";
    } else if (pendingBuy90s === 0) {
      hint = autoDemoRelaxEnabled()
        ? "0 queued BUYs in 90s — intelligence may not be emitting BUY_STRONG/MODERATE yet, or entry filters are blocking every candidate."
        : "0 pending BUY signals in the last 90s — decision worker may be paused or strict auto_trade_allowed gate is blocking.";
    } else if (session.params.signalStrictness === "strong") {
      hint = 'Session uses signalStrictness "strong" only — restart auto with strong_and_moderate for more trades.';
    }
  }

  // Phase 1 collection health: the worker is up and emitting BUYs, but the
  // feature-snapshotter isn't producing universe snapshots → lane crashed or
  // migration 0020 not applied. Surface it so weeks aren't wasted on no data.
  if (
    hint == null &&
    workersRunning &&
    (counts?.buy_1h ?? 0) > 0 &&
    measurement.snapshotsUniverse === 0
  ) {
    hint =
      "Worker is emitting BUY decisions but feature_snapshots is empty — the measurement lanes aren't collecting. Confirm migration 0020 applied and restart `pnpm worker`.";
  }

  const opensRes = await getDb().execute(sql`
    SELECT COUNT(*)::int AS n
    FROM paper_positions
    WHERE opened_at > now() - interval '30 minutes'
      AND COALESCE(entry_features->>'auto', 'false') = 'true'
  `);
  const autoPaperOpens30m =
    (opensRes as unknown as { rows: Array<{ n: number }> }).rows[0]?.n ?? 0;

  let continuationUniverse: AutoDiagnostics["continuationUniverse"];
  if (isProfitSignalMode()) {
    try {
      continuationUniverse = (await fetchContinuationUniverseStats()) ?? undefined;
    } catch {
      continuationUniverse = undefined;
    }
  }

  return {
    workersExpected,
    workersRunning,
    session,
    pendingBuy90s,
    buyDecisions1h: counts?.buy_1h ?? 0,
    skippedLast1h,
    circuitBreakerState: cb.state,
    signalMode: getEffectiveSignalMode(),
    riskPreset: e.RISK_PRESET,
    lastTickAt,
    tradesOpened: session?.stats?.tradesOpened ?? 0,
    hint,
    continuationUniverse,
    workerHeartbeats: getWorkerHeartbeats(),
    autoPaperOpens30m,
    autoDemoRelax: autoDemoRelaxEnabled(),
    entryFilter: "qualifyEntry",
    p22WarnOptionB:
      workersRunning &&
      !autoDemoRelaxEnabled() &&
      autoPaperOpens30m === 0 &&
      ((counts?.buy_1h ?? 0) > 0 || pendingBuy90s > 0),
    openPositions: { ...ownership, globalCap },
    solPrice: {
      usd: sol.usd,
      ageMs: Number.isFinite(sol.ageMs) ? sol.ageMs : null,
      fresh: sol.fresh,
      usingFallback: sol.usingFallback,
    },
    measurement,
    ingestGapsOpen,
    drift,
  };
}

export function diagnosticsSummary(d: AutoDiagnostics): string {
  const parts = [
    `workers ${d.workersRunning ? "OK" : d.workersExpected ? "stale" : "off"}`,
    `pending ${d.pendingBuy90s}`,
    `BUY/h ${d.buyDecisions1h}`,
    `CB ${d.circuitBreakerState}`,
    isProfitSignalMode() ? "profit mode" : "launch mode",
  ];
  if (d.session?.stats?.lastPendingCount != null) {
    parts.push(`last tick pending ${d.session.stats.lastPendingCount}`);
  }
  if (d.autoPaperOpens30m != null) {
    parts.push(`auto opens/30m ${d.autoPaperOpens30m}`);
  }
  return parts.join(" · ");
}
