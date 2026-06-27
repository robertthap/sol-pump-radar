import "server-only";
import { sql } from "drizzle-orm";
import { logger } from "@/lib/log";
import { getDb } from "@/lib/db/client";
import { computePSI, maxPsi, metaShiftDetected, type FeaturePsi } from "@/lib/intelligence/drift";
import { touchWorker } from "@/lib/workers/heartbeat";

/**
 * T1.3 — drift / meta-shift detector.
 *
 * Every ~10 min, compares the recent CURRENT window of the unbiased universe
 * sampler (feature_snapshots, sample_source='universe') against the BASELINE
 * window, computing PSI per monitored feature. Writes a drift_metrics row with
 * the per-feature PSI, max PSI, and a meta_shift flag (max PSI > 0.25). The
 * kill-gate (SYSTEM_DESIGN §8) reads this to verify its "window spanned ≥1 meta
 * shift" condition — without this lane the kill-gate has no anchor.
 *
 * Why the universe sampler (not traded positions): meta-shift is a property of
 * the MARKET, and feature_snapshots samples the active mint universe without
 * the selection bias of "only mints we traded."
 */
const log = logger("drift-monitor");
const TICK_MS = 10 * 60 * 1000;

// Core monitored features — the JSON keys in feature_snapshots.features. These
// are the unbiased-universe equivalents of the kill-gate's signal vector
// (volume, liquidity, maturity, order-flow, buyer breadth). Pinned here so the
// kill-gate's meta-shift definition is reproducible.
const MONITORED_FEATURES = [
  "dex_vol_m5",
  "dex_liq_usd",
  "grad_score",
  "dex_buy_sell_ratio",
  "unique_buyers_5m",
] as const;

// Window geometry. Baseline = the first 3 days of universe snapshots we have
// (the kill-gate's "first 3 days as baseline"); current = the trailing window.
const BASELINE_DAYS = 3;
const CURRENT_WINDOW_HOURS = 24;
const MIN_SAMPLES = 200; // need enough mass for a stable PSI

type FeatureRow = Record<string, number | null>;

async function fetchFeatureValues(where: ReturnType<typeof sql>): Promise<Map<string, number[]>> {
  // Pull the monitored feature values out of the jsonb in one pass.
  const cols = MONITORED_FEATURES.map(
    (f) => sql`(features->>${f})::float8 AS ${sql.raw(f)}`,
  );
  const res = await getDb().execute(sql`
    SELECT ${sql.join(cols, sql`, `)}
    FROM feature_snapshots
    WHERE sample_source = 'universe'
      AND features IS NOT NULL
      AND ${where}
  `);
  const rows = (res as unknown as { rows: FeatureRow[] }).rows;
  const out = new Map<string, number[]>();
  for (const f of MONITORED_FEATURES) out.set(f, []);
  for (const r of rows) {
    for (const f of MONITORED_FEATURES) {
      const v = r[f];
      if (v != null && Number.isFinite(v)) out.get(f)!.push(v);
    }
  }
  return out;
}

/** Baseline = first BASELINE_DAYS of universe data; anchored to the earliest snapshot. */
async function baselineBounds(): Promise<{ start: Date; end: Date } | null> {
  const res = await getDb().execute(sql`
    SELECT MIN(ts) AS first_ts FROM feature_snapshots WHERE sample_source = 'universe'
  `);
  const firstTs = (res as unknown as { rows: Array<{ first_ts: Date | string | null }> }).rows[0]?.first_ts;
  if (!firstTs) return null;
  const start = firstTs instanceof Date ? firstTs : new Date(firstTs);
  const end = new Date(start.getTime() + BASELINE_DAYS * 86_400_000);
  return { start, end };
}

async function positiveLabelRate(windowStart: Date): Promise<number | null> {
  // Positive-label base rate over the current window: fraction of completed
  // labels with a positive 1h forward return. A drifting base rate is itself a
  // regime signal (the model's positive class is moving).
  const res = await getDb().execute(sql`
    SELECT
      count(*) FILTER (WHERE ret_1h IS NOT NULL)::int AS labeled,
      count(*) FILTER (WHERE ret_1h > 0)::int AS positive
    FROM outcome_labels
    WHERE base_ts >= ${windowStart.toISOString()}::timestamptz
      AND blocked_reason IS NULL
  `);
  const r = (res as unknown as { rows: Array<{ labeled: number; positive: number }> }).rows[0];
  if (!r || r.labeled < 30) return null;
  return r.positive / r.labeled;
}

async function tick(): Promise<void> {
  touchWorker("drift-monitor");
  try {
    const base = await baselineBounds();
    if (!base) return; // no universe data yet

    const now = new Date();
    const curStart = new Date(now.getTime() - CURRENT_WINDOW_HOURS * 3_600_000);
    // If the current window overlaps the baseline (early days), there's nothing
    // to compare yet — skip until we have data past the baseline.
    if (curStart < base.end) {
      log.debug("current window still inside baseline; skipping", {
        curStart: curStart.toISOString(), baselineEnd: base.end.toISOString(),
      });
      return;
    }

    const baselineVals = await fetchFeatureValues(
      sql`ts >= ${base.start.toISOString()}::timestamptz AND ts < ${base.end.toISOString()}::timestamptz`,
    );
    const currentVals = await fetchFeatureValues(
      sql`ts >= ${curStart.toISOString()}::timestamptz`,
    );

    const baselineN = Math.max(...MONITORED_FEATURES.map((f) => baselineVals.get(f)!.length), 0);
    const currentN = Math.max(...MONITORED_FEATURES.map((f) => currentVals.get(f)!.length), 0);
    if (baselineN < MIN_SAMPLES || currentN < MIN_SAMPLES) {
      log.debug("insufficient samples for PSI", { baselineN, currentN, need: MIN_SAMPLES });
      return;
    }

    const psiByFeature: FeaturePsi = {};
    for (const f of MONITORED_FEATURES) {
      psiByFeature[f] = computePSI(baselineVals.get(f)!, currentVals.get(f)!);
    }
    const mPsi = maxPsi(psiByFeature);
    const shift = metaShiftDetected(psiByFeature);
    const posRate = await positiveLabelRate(curStart);

    await getDb().execute(sql`
      INSERT INTO drift_metrics
        (window_start, window_end, baseline_start, baseline_end,
         psi_by_feature, max_psi, meta_shift, positive_label_rate, baseline_n, current_n)
      VALUES
        (${curStart.toISOString()}, ${now.toISOString()},
         ${base.start.toISOString()}, ${base.end.toISOString()},
         ${JSON.stringify(psiByFeature)}::jsonb, ${mPsi}, ${shift},
         ${posRate}, ${baselineN}, ${currentN})
    `);

    log.info("drift computed", {
      maxPsi: mPsi.toFixed(3), metaShift: shift,
      posLabelRate: posRate?.toFixed(3) ?? "n/a", baselineN, currentN,
    });
  } catch (e) {
    log.warn("drift tick failed", { err: String(e) });
  }
}

export function startDriftMonitor(): () => void {
  log.info("drift-monitor starting", { tickMs: TICK_MS, features: MONITORED_FEATURES });
  void tick();
  const id = setInterval(() => void tick(), TICK_MS);
  return () => clearInterval(id);
}

/** Latest drift snapshot for diagnostics / health. */
export async function latestDrift(): Promise<{ maxPsi: number; metaShift: boolean; computedAt: string } | null> {
  const res = await getDb().execute(sql`
    SELECT max_psi::float8 AS max_psi, meta_shift,
      to_char(computed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS computed_at
    FROM drift_metrics ORDER BY computed_at DESC LIMIT 1
  `);
  const r = (res as unknown as { rows: Array<{ max_psi: number; meta_shift: boolean; computed_at: string }> }).rows[0];
  return r ? { maxPsi: r.max_psi, metaShift: r.meta_shift, computedAt: r.computed_at } : null;
}
