import "server-only";
import { sql, desc, eq, and } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { tunerChanges } from "@/lib/db/schema";

export type ThresholdDiff = {
  gradBuyStrong?: number;
  gradBuyModerate?: number;
  gradWatch?: number;
  rugBuyCap?: number;
  rugAvoid?: number;
  gateWeightWallet?: number;
  gateWeightCoin?: number;
  gateWeightTiming?: number;
  // Auto-trade gate floors (mode/stage-aware gate — see lib/intelligence/gate-config.ts).
  // Clamped to a bounded deviation from preset when applied.
  liqFloorBaseUsd?: number;
  engineALiqFloorUsd?: number;
  engineARankFloor?: number;
  engineAVelocityFloor?: number;
  engineBRankFloor?: number;
};

export type TunerChangeRow = {
  id: string;
  ts: string;
  reason: string;
  diff: ThresholdDiff;
  metricsBefore: Record<string, unknown> | null;
  metricsAfter: Record<string, unknown> | null;
  reverted: string;
  status: "applied" | "proposed" | "reverted";
};

function classify(row: { reverted: string; diff: unknown }): TunerChangeRow["status"] {
  if (row.reverted === "yes") return "reverted";
  if (row.diff && typeof row.diff === "object" && Object.keys(row.diff as object).length === 0) return "proposed";
  if (row.reverted === "no") return "applied";
  return "proposed";
}

export async function readActiveOverrides(): Promise<ThresholdDiff> {
  const rows = await getDb()
    .select()
    .from(tunerChanges)
    .where(eq(tunerChanges.reverted, "no"))
    .orderBy(desc(tunerChanges.ts));
  const merged: ThresholdDiff = {};
  for (const r of rows) {
    const d = (r.diff ?? {}) as ThresholdDiff;
    if (d.gradBuyStrong != null && merged.gradBuyStrong == null) merged.gradBuyStrong = d.gradBuyStrong;
    if (d.gradBuyModerate != null && merged.gradBuyModerate == null) merged.gradBuyModerate = d.gradBuyModerate;
    if (d.gradWatch != null && merged.gradWatch == null) merged.gradWatch = d.gradWatch;
    if (d.rugBuyCap != null && merged.rugBuyCap == null) merged.rugBuyCap = d.rugBuyCap;
    if (d.rugAvoid != null && merged.rugAvoid == null) merged.rugAvoid = d.rugAvoid;
    if (d.gateWeightWallet != null && merged.gateWeightWallet == null) merged.gateWeightWallet = d.gateWeightWallet;
    if (d.gateWeightCoin != null && merged.gateWeightCoin == null) merged.gateWeightCoin = d.gateWeightCoin;
    if (d.gateWeightTiming != null && merged.gateWeightTiming == null) merged.gateWeightTiming = d.gateWeightTiming;
    if (d.liqFloorBaseUsd != null && merged.liqFloorBaseUsd == null) merged.liqFloorBaseUsd = d.liqFloorBaseUsd;
    if (d.engineALiqFloorUsd != null && merged.engineALiqFloorUsd == null) merged.engineALiqFloorUsd = d.engineALiqFloorUsd;
    if (d.engineARankFloor != null && merged.engineARankFloor == null) merged.engineARankFloor = d.engineARankFloor;
    if (d.engineAVelocityFloor != null && merged.engineAVelocityFloor == null) merged.engineAVelocityFloor = d.engineAVelocityFloor;
    if (d.engineBRankFloor != null && merged.engineBRankFloor == null) merged.engineBRankFloor = d.engineBRankFloor;
  }
  return merged;
}

export async function readActiveGateWeights(): Promise<{ wallet: number; coin: number; timing: number }> {
  const o = await readActiveOverrides();
  // Defaults match three-gate.ts default.
  let w = o.gateWeightWallet ?? 0.4;
  let c = o.gateWeightCoin ?? 0.4;
  let t = o.gateWeightTiming ?? 0.2;
  // Re-normalise (defensive — in case stored values drift).
  const s = w + c + t;
  if (s > 0 && Math.abs(s - 1) > 0.001) {
    w /= s;
    c /= s;
    t /= s;
  }
  return { wallet: w, coin: c, timing: t };
}

export async function recordChange(opts: {
  diff: ThresholdDiff;
  reason: string;
  metricsBefore: Record<string, unknown>;
  metricsAfter?: Record<string, unknown>;
  applied: boolean;
}): Promise<string> {
  const reason = opts.reason.slice(0, 126);
  const db = getDb();
  // Dedupe: the learner runs on a loop and would otherwise re-record an identical
  // change/note every tick (e.g. the "Stop-loss exits N/M" review note piled up
  // 7×). Skip if the same reason was already recorded (and not reverted) recently.
  const dupe = await db
    .select({ id: tunerChanges.id })
    .from(tunerChanges)
    .where(
      and(
        eq(tunerChanges.reason, reason),
        eq(tunerChanges.reverted, "no"),
        sql`${tunerChanges.ts} > now() - interval '24 hours'`,
      ),
    )
    .limit(1);
  if (dupe.length) return dupe[0]!.id.toString();

  const [row] = await db
    .insert(tunerChanges)
    .values({
      reason,
      diff: opts.applied ? opts.diff : {},
      metricsBefore: opts.metricsBefore,
      metricsAfter: opts.metricsAfter ?? null,
      reverted: "no",
    })
    .returning({ id: tunerChanges.id });
  return row?.id.toString() ?? "";
}

export async function listRecentChanges(limit = 20): Promise<TunerChangeRow[]> {
  const res = await getDb().execute(sql`
    SELECT
      id::text AS id,
      ts,
      reason::text AS reason,
      diff,
      metrics_before,
      metrics_after,
      reverted::text AS reverted
    FROM tuner_changes
    ORDER BY ts DESC
    LIMIT ${sql.raw(String(limit))}
  `);
  type Raw = {
    id: string;
    ts: Date | string;
    reason: string;
    diff: Record<string, unknown>;
    metrics_before: Record<string, unknown> | null;
    metrics_after: Record<string, unknown> | null;
    reverted: string;
  };
  const rows = (res as unknown as { rows: Raw[] }).rows;
  return rows.map((r) => ({
    id: r.id,
    ts: r.ts instanceof Date ? r.ts.toISOString() : String(r.ts),
    reason: r.reason ?? "",
    diff: (r.diff ?? {}) as ThresholdDiff,
    metricsBefore: r.metrics_before,
    metricsAfter: r.metrics_after,
    reverted: r.reverted,
    status: classify(r),
  }));
}
