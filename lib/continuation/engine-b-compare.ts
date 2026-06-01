import "server-only";
import { sql } from "drizzle-orm";
import { bootDb, getDb } from "@/lib/db/client";
import { fetchDexMarketBatch, fetchDexBoostMints } from "@/lib/dex/market-snapshot";
import { normalizeDexSnapshot } from "@/lib/dex/normalizer";
import { engineB, engineBAsync } from "@/lib/continuation/engine-b";
import { evaluateEngineABaseline } from "@/lib/continuation/engine-a-baseline";
import { EVAL_MINTS_V1, ENGINE_B_EVAL_SET } from "@/lib/continuation/eval-set";
import { classifyMiss } from "@/lib/continuation/miss-classifier";
import { fetchTracesForMint } from "@/lib/continuation/trace-store";
import { getDetectionTiming, touchDetectionTiming } from "@/lib/continuation/detection-timing";
import { computeCrossMintRanks, rankInputFromResult } from "@/lib/continuation/cross-mint-rank";
import { runEngineBReplay } from "@/lib/continuation/replay-runner";
import { ENGINE_B_VERSION, type DetectionTiming, type EngineBAction, type MissType } from "@/lib/continuation/types";
import type { EvalExpectation } from "@/lib/continuation/types";

export type EngineCompareMintRow = {
  mint: string;
  symbol: string;
  dexH24: number | null;
  engineA: {
    action: string;
    coverage: string;
    firstDetectionTs: number | null;
    missType: MissType;
    reason: string;
    hasLocalEvents: boolean;
  };
  engineB: {
    action: EngineBAction;
    state: string;
    rankPercentile: number;
    firstDetectionTs: number | null;
    missType: MissType;
    reason: string;
  };
  timing: DetectionTiming;
  /** Negative = Engine B detected earlier (ms). Positive = Engine A earlier. */
  firstDetectionDeltaMs: number | null;
  rankAtDetection: { engineB: number | null };
  stateTimelineB: Array<{ ts: number; state: string; action: string; rank: number }>;
  missTypeDelta: string;
  bAdvantage: {
    stateMachine: boolean;
    rankContext: boolean;
    earlierDetection: boolean | null;
    betterMissClassification: boolean;
  };
  verdict: "b_better" | "a_better" | "tie" | "both_missed" | "inconclusive";
};

export type EngineCompareReport = {
  runAt: number;
  engineBVersion: string;
  cohort: "eval_8" | "dex_top50" | "combined";
  mintCount: number;
  summary: {
    bEarlierCount: number;
    aEarlierCount: number;
    bothMissed: number;
    bBetterVerdict: number;
    aBetterVerdict: number;
    tie: number;
    avgFirstDetectionDeltaMs: number | null;
  };
  rows: EngineCompareMintRow[];
};

async function fetchFirstEngineBDetectionTs(mint: string): Promise<number | null> {
  await bootDb();
  try {
    const res = await getDb().execute(sql`
      SELECT EXTRACT(EPOCH FROM MIN(ts)) * 1000 AS ts_ms
      FROM engine_b_traces
      WHERE mint = ${mint}
        AND (trace->'outputs'->>'action') IN ('ALERT', 'CONTINUATION_BUY', 'WATCH')
    `);
    const v = (res as unknown as { rows: Array<{ ts_ms: number | null }> }).rows[0]?.ts_ms;
    return v != null && Number.isFinite(v) ? Math.round(v) : null;
  } catch {
    return null;
  }
}

function mapActionToEval(action: string): EvalExpectation {
  if (action === "NONE" || action === "AVOID") return "NONE";
  if (action === "WATCH") return "WATCH";
  return "ALERT";
}

async function compareMint(
  mint: string,
  symbol: string,
  markets: Map<string, import("@/lib/dex/market-snapshot").DexMarketSnapshot>,
  rankTable: Map<string, { rankPercentile: number; rankVelocity: number }>,
): Promise<EngineCompareMintRow> {
  const raw = markets.get(mint);
  const dexH24 = raw?.priceChangeH24 ?? null;
  const expected: EvalExpectation = "ALERT";

  const engineA = await evaluateEngineABaseline(mint, expected);

  let engineBAction: EngineBAction = "NONE";
  let engineBState = "cold";
  let engineBRank = 0;
  let engineBReason = "not_normalized";
  let engineBMiss: MissType = "NOT_NORMALIZED";
  let timing = getDetectionTiming(mint);

  if (raw) {
    const normalized = normalizeDexSnapshot(raw);
    const rank = rankTable.get(mint) ?? { rankPercentile: 0.5, rankVelocity: 0 };
    touchDetectionTiming(mint, { seen: true }, Date.now());
    const { result, trace } = await engineBAsync(mint, normalized, {
      rankPercentile: rank.rankPercentile,
      rankVelocity: rank.rankVelocity,
      eventImpulse: 0,
      leadingScore: 0,
      universeSize: rankTable.size,
      persistTrace: true,
    });
    timing = trace.timing ?? touchDetectionTiming(mint, {
      seen: true,
      signalAction: result.action,
      rankPercentile: result.rankPercentile,
      state: result.state,
    });
    engineBAction = result.action;
    engineBState = result.state;
    engineBRank = result.rankPercentile;
    engineBReason = result.reason;
    const traces = await fetchTracesForMint(mint, 30);
    engineBMiss = classifyMiss({
      mint,
      expected,
      actual: result.action,
      inUniverse: true,
      normalized: true,
      traces,
      opsHealthy: true,
      dexH24,
    });
  }

  const firstBFromDb = await fetchFirstEngineBDetectionTs(mint);
  const firstB = timing.firstSignalTs ?? firstBFromDb;
  const firstA = engineA.firstDetectionTs;
  let firstDetectionDeltaMs: number | null = null;
  if (firstA != null && firstB != null) firstDetectionDeltaMs = firstA - firstB;

  const replay = await runEngineBReplay({ mints: [mint], timeWindowHours: 6, stepMinutes: 5 });
  const stateTimelineB =
    replay.mints[0]?.steps.map((s) => ({
      ts: s.ts,
      state: s.state,
      action: s.action,
      rank: s.rankPercentile,
    })) ?? [];

  const missTypeDelta =
    engineA.missType === engineBMiss
      ? "same"
      : engineA.missType === "NONE" && engineBMiss !== "NONE"
        ? "a_ok_b_miss"
        : engineBMiss === "NONE" && engineA.missType !== "NONE"
          ? "b_ok_a_miss"
          : `${engineA.missType}_vs_${engineBMiss}`;

  const bAdvantage = {
    stateMachine: engineBState !== "cold",
    rankContext: engineBRank >= 0.5,
    earlierDetection: firstDetectionDeltaMs != null ? firstDetectionDeltaMs > 0 : null,
    betterMissClassification:
      engineA.missType !== "NONE" && engineBMiss === "NONE",
  };

  let verdict: EngineCompareMintRow["verdict"] = "inconclusive";
  if (engineA.action === "NONE" && engineBAction === "NONE") verdict = "both_missed";
  else if (bAdvantage.earlierDetection === true && (engineBAction === "ALERT" || engineBAction === "CONTINUATION_BUY")) {
    verdict = "b_better";
  } else if (engineBMiss === "NONE" && engineA.missType !== "NONE") verdict = "b_better";
  else if (engineA.firstDetectionTs != null && firstB == null) verdict = "a_better";
  else if (engineBAction !== "NONE" && engineA.action === "NONE") verdict = "b_better";
  else if (engineA.action !== "NONE" && engineBAction === "NONE") verdict = "a_better";
  else verdict = "tie";

  return {
    mint,
    symbol,
    dexH24,
    engineA: {
      action: engineA.action,
      coverage: engineA.coverage,
      firstDetectionTs: firstA,
      missType: engineA.missType,
      reason: engineA.reason,
      hasLocalEvents: engineA.hasLocalEvents,
    },
    engineB: {
      action: engineBAction,
      state: engineBState,
      rankPercentile: engineBRank,
      firstDetectionTs: firstB,
      missType: engineBMiss,
      reason: engineBReason,
    },
    timing,
    firstDetectionDeltaMs,
    rankAtDetection: { engineB: engineBRank },
    stateTimelineB,
    missTypeDelta,
    bAdvantage,
    verdict,
  };
}

export async function runEngineBCompare(opts?: {
  mints?: string[];
  includeDexTop50?: boolean;
}): Promise<EngineCompareReport> {
  const evalMints = opts?.mints ?? ENGINE_B_EVAL_SET;
  const symbols = new Map(EVAL_MINTS_V1.map((m) => [m.mint, m.symbol]));

  let allMints = [...evalMints];
  let cohort: EngineCompareReport["cohort"] = "eval_8";

  if (opts?.includeDexTop50 !== false) {
    const top = await fetchDexBoostMints(50);
    allMints = [...new Set([...allMints, ...top])];
    cohort = evalMints.length >= 8 && top.length > 0 ? "combined" : cohort;
  }

  const markets = await fetchDexMarketBatch(allMints);

  const rankInputs: ReturnType<typeof rankInputFromResult>[] = [];
  for (const mint of allMints) {
    const raw = markets.get(mint);
    if (!raw) continue;
    const norm = normalizeDexSnapshot(raw);
    const { result } = engineB(mint, norm, {
      rankPercentile: 0.5,
      rankVelocity: 0,
      eventImpulse: 0,
      leadingScore: 0,
      universeSize: allMints.length,
      persistTrace: false,
    });
    rankInputs.push(rankInputFromResult(mint, norm, result));
  }
  const rankTable = computeCrossMintRanks(
    rankInputs.map((r) => ({
      mint: r.mint,
      continuationScore: r.continuationScore,
      volAcceleration: r.volAcceleration,
      weightedLiqUsd: r.weightedLiqUsd,
      priceChangeH24: r.priceChangeH24,
    })),
    new Map(),
    1,
  );

  const rows: EngineCompareMintRow[] = [];
  for (const mint of allMints) {
    rows.push(
      await compareMint(mint, symbols.get(mint) ?? mint.slice(0, 8), markets, rankTable),
    );
  }

  const deltas = rows
    .map((r) => r.firstDetectionDeltaMs)
    .filter((d): d is number => d != null);
  const summary = {
    bEarlierCount: deltas.filter((d) => d > 0).length,
    aEarlierCount: deltas.filter((d) => d < 0).length,
    bothMissed: rows.filter((r) => r.verdict === "both_missed").length,
    bBetterVerdict: rows.filter((r) => r.verdict === "b_better").length,
    aBetterVerdict: rows.filter((r) => r.verdict === "a_better").length,
    tie: rows.filter((r) => r.verdict === "tie").length,
    avgFirstDetectionDeltaMs:
      deltas.length > 0 ? deltas.reduce((a, b) => a + b, 0) / deltas.length : null,
  };

  const report: EngineCompareReport = {
    runAt: Date.now(),
    engineBVersion: ENGINE_B_VERSION,
    cohort,
    mintCount: rows.length,
    summary,
    rows,
  };

  try {
    await bootDb();
    await getDb().execute(sql`
      INSERT INTO engine_b_eval_runs (eval_set_version, market_snapshot_at, report, engine_b_version)
      VALUES (
        ${`compare-${cohort}-${new Date().toISOString().slice(0, 10)}`},
        now(),
        ${JSON.stringify(report)}::jsonb,
        ${ENGINE_B_VERSION}
      )
    `);
  } catch {
    /* optional */
  }

  return report;
}
