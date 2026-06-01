import "server-only";
import { sql } from "drizzle-orm";
import { bootDb, getDb } from "@/lib/db/client";
import { fetchDexMarketBatch } from "@/lib/dex/market-snapshot";
import { normalizeDexSnapshot } from "@/lib/dex/normalizer";
import { engineB, engineBAsync } from "@/lib/continuation/engine-b";
import { buildEvalSetSnapshot, EVAL_MINTS_V1 } from "@/lib/continuation/eval-set";
import { classifyMiss, divergenceLabel } from "@/lib/continuation/miss-classifier";
import { fetchTracesForMint } from "@/lib/continuation/trace-store";
import { computeCrossMintRanks, rankInputFromResult } from "@/lib/continuation/cross-mint-rank";
import { ENGINE_B_VERSION, type EvalRunResult, type EvalMintRow, type MomentumState } from "@/lib/continuation/types";
import { env } from "@/lib/env";
import { getPriorState, updateMintStateRegistry } from "@/lib/continuation/state-registry";

async function seedPriorStatesFromDb(mints: string[]) {
  try {
    const res = await getDb().execute(sql`
      SELECT mint, momentum_state FROM continuation_candidates
      WHERE mint = ANY(${sql.raw(
        `ARRAY[${mints.map((m) => `'${m.replace(/'/g, "''")}'`).join(",")}]::text[]`,
      )})
    `);
    const rows = (res as unknown as { rows: Array<{ mint: string; momentum_state: string }> })
      .rows;
    for (const row of rows) {
      if (row.momentum_state) {
        updateMintStateRegistry(row.mint, row.momentum_state as MomentumState, 0.5);
      }
    }
  } catch {
    /* candidates table optional */
  }
}

export async function runEngineBEval(opsHealthy = true): Promise<EvalRunResult> {
  await bootDb();
  const mints = EVAL_MINTS_V1.map((m) => m.mint);
  await seedPriorStatesFromDb(mints);
  const markets = await fetchDexMarketBatch(mints);
  const metrics = new Map<string, { h24: number; liqUsd: number }>();

  const rankRows: ReturnType<typeof rankInputFromResult>[] = [];
  const prepared: Array<{
    def: (typeof EVAL_MINTS_V1)[0];
    normalized: ReturnType<typeof normalizeDexSnapshot> | null;
    raw: NonNullable<ReturnType<typeof markets.get>>;
  }> = [];

  for (const def of EVAL_MINTS_V1) {
    const raw = markets.get(def.mint);
    if (!raw) {
      prepared.push({ def, normalized: null, raw: undefined as never });
      continue;
    }
    const normalized = normalizeDexSnapshot(raw);
    metrics.set(def.mint, {
      h24: raw.priceChangeH24 ?? 0,
      liqUsd: normalized.weightedLiqUsd,
    });
    const { result } = engineB(def.mint, normalized, {
      rankPercentile: 0.5,
      rankVelocity: 0,
      eventImpulse: 0,
      leadingScore: 0,
      universeSize: mints.length,
      persistTrace: false,
    });
    rankRows.push(rankInputFromResult(def.mint, normalized, result));
    prepared.push({ def, normalized, raw });
  }

  const ranks = computeCrossMintRanks(
    rankRows.map((r) => ({
      mint: r.mint,
      continuationScore: r.continuationScore,
      volAcceleration: r.volAcceleration,
      weightedLiqUsd: r.weightedLiqUsd,
      priceChangeH24: r.priceChangeH24,
    })),
    new Map(),
    1,
  );

  const evalSet = buildEvalSetSnapshot(metrics);
  const rows: EvalMintRow[] = [];

  for (const item of prepared) {
    const { def, normalized } = item;
    if (!normalized) {
      rows.push({
        mint: def.mint,
        symbol: def.symbol,
        state: "cold",
        rankPercentile: 0,
        rankVelocity: 0,
        action: "NONE",
        reason: "not_normalized",
        expected: def.expected,
        actual: "NONE",
        divergence: "missed_entirely",
        missType: "NOT_NORMALIZED",
        primaryMissCause: "NOT_NORMALIZED",
      });
      continue;
    }

    const rank = ranks.get(def.mint) ?? {
      rankPercentile: 0.5,
      rankVelocity: 0,
      volRankPercentile: 0.5,
      liqRankPercentile: 0.5,
    };

    const { result, trace } = await engineBAsync(def.mint, normalized, {
      priorState: getPriorState(def.mint),
      rankPercentile: rank.rankPercentile,
      rankVelocity: rank.rankVelocity,
      eventImpulse: 0,
      leadingScore: 0,
      universeSize: mints.length,
      persistTrace: true,
    });

    const traces = await fetchTracesForMint(def.mint, 20);
    if (!traces.find((t) => t.timestamp === trace.timestamp)) {
      traces.push(trace);
    }

    let inUniverse = false;
    try {
      const u = await getDb().execute(sql`
        SELECT 1 FROM continuation_candidates WHERE mint = ${def.mint} LIMIT 1
      `);
      inUniverse = ((u as unknown as { rows: unknown[] }).rows?.length ?? 0) > 0;
    } catch {
      inUniverse = false;
    }

    const missType = classifyMiss({
      mint: def.mint,
      expected: def.expected,
      actual: result.action,
      inUniverse,
      normalized: true,
      traces,
      opsHealthy,
      dexH24: item.raw?.priceChangeH24,
    });

    rows.push({
      mint: def.mint,
      symbol: def.symbol,
      state: result.state,
      rankPercentile: result.rankPercentile,
      rankVelocity: result.rankVelocity,
      action: result.action,
      reason: result.reason,
      expected: def.expected,
      actual: result.action,
      divergence: divergenceLabel(result.action, def.expected),
      missType: missType === "NONE" ? undefined : missType,
      primaryMissCause: missType,
    });
  }

  const matched = rows.filter((r) => r.divergence === "match").length;
  const missed = rows.filter((r) => r.divergence === "missed_entirely").length;
  const opsBlocked = rows.filter((r) => r.missType === "OPS_FAILURE").length;

  const report: EvalRunResult = {
    evalSetVersion: evalSet.version,
    marketSnapshotAt: evalSet.marketSnapshotAt,
    runAt: Date.now(),
    engineBVersion: ENGINE_B_VERSION,
    rows,
    summary: { matched, missed, opsBlocked },
  };

  try {
    await getDb().execute(sql`
      INSERT INTO engine_b_eval_runs (eval_set_version, market_snapshot_at, report, engine_b_version)
      VALUES (
        ${report.evalSetVersion},
        to_timestamp(${report.marketSnapshotAt / 1000}),
        ${JSON.stringify(report)}::jsonb,
        ${ENGINE_B_VERSION}
      )
    `);
  } catch {
    /* table may not exist yet */
  }

  return report;
}

export async function fetchEvalRunById(id: number): Promise<EvalRunResult | null> {
  await bootDb();
  try {
    const res = await getDb().execute(sql`
      SELECT report FROM engine_b_eval_runs WHERE id = ${id} LIMIT 1
    `);
    const row = (res as unknown as { rows: Array<{ report: EvalRunResult }> }).rows[0];
    return row?.report ?? null;
  } catch {
    return null;
  }
}

export async function diffEvalRuns(idA: number, idB: number) {
  const [a, b] = await Promise.all([fetchEvalRunById(idA), fetchEvalRunById(idB)]);
  if (!a || !b) return null;
  const diffs = a.rows.map((ra) => {
    const rb = b.rows.find((x) => x.mint === ra.mint);
    return {
      mint: ra.mint,
      symbol: ra.symbol,
      actionA: ra.action,
      actionB: rb?.action,
      missA: ra.missType,
      missB: rb?.missType,
    };
  });
  return { runA: idA, runB: idB, diffs };
}

export async function checkOpsHealthy(): Promise<boolean> {
  return env().WORKERS === "on";
}
