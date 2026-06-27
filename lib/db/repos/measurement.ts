import "server-only";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { featureSnapshots } from "@/lib/db/schema/measurement";

export type FeatureSnapshotInput = {
  mint: string;
  // 'post_exit': a snapshot written at the moment a position closes, so the
  // label-builder matures forward 5m/30m/1h/6h returns vs the exit price — the
  // signal that says "did the coin we just sold go up (we exited too early) or
  // down (good exit)". Reuses the existing maturation lane; no new schema.
  sampleSource: "universe" | "control" | "shadow" | "post_exit";
  features: Record<string, unknown>;
  engineOutputs?: Record<string, unknown> | null;
  staleFlags?: Record<string, unknown> | null;
  decisionId?: bigint | null;
  refVSol?: number | null;
  refMcapUsd?: number | null;
};

/** Write a post-exit snapshot so the labeler can score "what happened next". */
export async function recordPostExitSnapshot(opts: {
  mint: string;
  positionId: number | bigint | string;
  exitVSol: number | null;
  exitMcapUsd?: number | null;
  exitReason: string;
}): Promise<void> {
  if (opts.exitVSol == null || !Number.isFinite(opts.exitVSol) || opts.exitVSol <= 0) return;
  await insertFeatureSnapshots([
    {
      mint: opts.mint,
      sampleSource: "post_exit",
      features: { exit_reason: opts.exitReason, position_id: String(opts.positionId) },
      decisionId: BigInt(opts.positionId),
      refVSol: opts.exitVSol,
      refMcapUsd: opts.exitMcapUsd ?? null,
    },
  ]);
}

/** Batch-insert immutable point-in-time feature snapshots. */
export async function insertFeatureSnapshots(rows: FeatureSnapshotInput[]): Promise<number> {
  if (rows.length === 0) return 0;
  await getDb()
    .insert(featureSnapshots)
    .values(
      rows.map((r) => ({
        mint: r.mint,
        sampleSource: r.sampleSource,
        features: r.features,
        engineOutputs: r.engineOutputs ?? null,
        staleFlags: r.staleFlags ?? null,
        decisionId: r.decisionId ?? null,
        refVSol: r.refVSol ?? null,
        refMcapUsd: r.refMcapUsd ?? null,
      })),
    );
  return rows.length;
}

/** Mints already snapshotted (any source) within the last `withinSec` — dedupe guard. */
export async function recentlySnapshottedMints(
  source: "universe" | "control" | "shadow",
  withinSec: number,
): Promise<Set<string>> {
  const res = await getDb().execute(sql`
    SELECT DISTINCT mint::text AS mint
    FROM feature_snapshots
    WHERE sample_source = ${source}
      AND ts > now() - (${sql.raw(String(Math.max(1, Math.floor(withinSec))))} || ' seconds')::interval
  `);
  return new Set((res as unknown as { rows: Array<{ mint: string }> }).rows.map((r) => r.mint));
}

export type MaturingSnapshot = {
  id: string;
  mint: string;
  ts: Date;
  refVSol: number | null;
  refMcapUsd: number | null;
  ageSec: number;
};

/**
 * Snapshots whose first horizon (5m) has matured but which are not yet fully
 * labelled. (Forward returns are computed on SOL-price-independent vSol ratios,
 * so a fallback SOL price at capture does not affect label correctness.)
 */
export async function fetchMaturingSnapshots(limit = 200): Promise<MaturingSnapshot[]> {
  // post_exit snapshots are matured by the dedicated post-exit poller (it uses
  // pump.fun API mcap so it can see graduated coins, which `events` cannot).
  const res = await getDb().execute(sql`
    SELECT fs.id::text AS id, fs.mint, fs.ts,
      fs.ref_v_sol::float8 AS ref_v_sol,
      fs.ref_mcap_usd::float8 AS ref_mcap_usd,
      EXTRACT(EPOCH FROM (now() - fs.ts))::float8 AS age_sec
    FROM feature_snapshots fs
    LEFT JOIN outcome_labels ol ON ol.snapshot_id = fs.id
    WHERE fs.ts < now() - interval '5 minutes'
      AND fs.sample_source <> 'post_exit'
      AND (ol.id IS NULL OR ol.horizons_complete = false)
    ORDER BY fs.ts ASC
    LIMIT ${limit}
  `);
  return (
    res as unknown as {
      rows: Array<{
        id: string;
        mint: string;
        ts: Date | string;
        ref_v_sol: number | null;
        ref_mcap_usd: number | null;
        age_sec: number;
      }>;
    }
  ).rows.map((r) => ({
    id: r.id,
    mint: r.mint,
    ts: r.ts instanceof Date ? r.ts : new Date(r.ts),
    refVSol: r.ref_v_sol,
    refMcapUsd: r.ref_mcap_usd,
    ageSec: r.age_sec,
  }));
}

export type OutcomeLabelUpsert = {
  snapshotId: string;
  mint: string;
  baseTs: Date;
  ret5m: number | null;
  ret30m: number | null;
  ret1h: number | null;
  ret6h: number | null;
  maxGainPct: number | null;
  maxDrawdownPct: number | null;
  isRug: boolean | null;
  isBreakout: boolean | null;
  timeToPeakSec: number | null;
  timeToGraduationSec: number | null;
  horizonsComplete: boolean;
  /** T1.1 — non-null indicates the label was NOT computed and why (e.g. 'gap'). */
  blockedReason?: string | null;
};

/** Idempotent upsert keyed on snapshot_id (labels refine as later horizons mature). */
export async function upsertOutcomeLabel(l: OutcomeLabelUpsert): Promise<void> {
  await getDb().execute(sql`
    INSERT INTO outcome_labels
      (snapshot_id, mint, base_ts, ret_5m, ret_30m, ret_1h, ret_6h,
       max_gain_pct, max_drawdown_pct, is_rug, is_breakout,
       time_to_peak_sec, time_to_graduation_sec, horizons_complete,
       blocked_reason, label_ready_at)
    VALUES
      (${BigInt(l.snapshotId)}, ${l.mint}, ${l.baseTs.toISOString()},
       ${l.ret5m}, ${l.ret30m}, ${l.ret1h}, ${l.ret6h},
       ${l.maxGainPct}, ${l.maxDrawdownPct}, ${l.isRug}, ${l.isBreakout},
       ${l.timeToPeakSec}, ${l.timeToGraduationSec}, ${l.horizonsComplete},
       ${l.blockedReason ?? null}, now())
    ON CONFLICT (snapshot_id) DO UPDATE SET
      ret_5m = EXCLUDED.ret_5m,
      ret_30m = EXCLUDED.ret_30m,
      ret_1h = EXCLUDED.ret_1h,
      ret_6h = EXCLUDED.ret_6h,
      max_gain_pct = EXCLUDED.max_gain_pct,
      max_drawdown_pct = EXCLUDED.max_drawdown_pct,
      is_rug = EXCLUDED.is_rug,
      is_breakout = EXCLUDED.is_breakout,
      time_to_peak_sec = EXCLUDED.time_to_peak_sec,
      time_to_graduation_sec = EXCLUDED.time_to_graduation_sec,
      horizons_complete = EXCLUDED.horizons_complete,
      blocked_reason = EXCLUDED.blocked_reason,
      label_ready_at = now()
  `);
}

export type MeasurementCounts = {
  snapshotsUniverse: number;
  snapshotsControl: number;
  labelsComplete: number;
  labelsPending: number;
};

/** Lightweight progress counters for diagnostics / eval. */
export async function fetchMeasurementCounts(): Promise<MeasurementCounts> {
  const res = await getDb().execute(sql`
    SELECT
      (SELECT COUNT(*) FROM feature_snapshots WHERE sample_source = 'universe')::int AS snap_universe,
      (SELECT COUNT(*) FROM feature_snapshots WHERE sample_source = 'control')::int AS snap_control,
      (SELECT COUNT(*) FROM outcome_labels WHERE horizons_complete)::int AS labels_complete,
      (SELECT COUNT(*) FROM outcome_labels WHERE NOT horizons_complete)::int AS labels_pending
  `);
  const r = (
    res as unknown as {
      rows: Array<{ snap_universe: number; snap_control: number; labels_complete: number; labels_pending: number }>;
    }
  ).rows[0];
  return {
    snapshotsUniverse: r?.snap_universe ?? 0,
    snapshotsControl: r?.snap_control ?? 0,
    labelsComplete: r?.labels_complete ?? 0,
    labelsPending: r?.labels_pending ?? 0,
  };
}
