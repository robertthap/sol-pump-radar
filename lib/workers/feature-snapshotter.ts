import "server-only";
import { sql } from "drizzle-orm";
import { logger } from "@/lib/log";
import { getDb } from "@/lib/db/client";
import {
  insertFeatureSnapshots,
  recentlySnapshottedMints,
  type FeatureSnapshotInput,
} from "@/lib/db/repos/measurement";
import { solUsdFreshness } from "@/lib/market/sol-usd";
import { dexMarketCacheAgeMs } from "@/lib/dex/snapshot-cache";
import { mcapUsdFromVSol } from "@/lib/pricing/seam";
import { touchWorker } from "@/lib/workers/heartbeat";
import { snapshotStaleFlags } from "@/lib/workers/stale-flags";

/**
 * Upgrade-plan Phase 1 — point-in-time feature capture for UNIVERSE mints.
 *
 * Every evaluation should become a clean training example. This lane snapshots
 * the feature vector of each recently-evaluated mint (one decision_log row in the
 * last window) joined with its latest token_features + dex_features. Immutable;
 * forward outcomes are filled later by the label lane. De-dupes within a short
 * window so a mint re-evaluated every 3s isn't snapshotted 5× per 15s.
 */
const log = logger("feature-snapshotter");
const TICK_MS = 15_000;
const DEDUPE_SEC = 25;

type Row = {
  mint: string;
  action: string;
  confluence_score: number | null;
  module_scores: Record<string, number> | null;
  decision_id: string | null;
  v_sol: number | null;
  curve_progress: number | null;
  curve_velocity_5m: number | null;
  buys_5m: number | null;
  sells_5m: number | null;
  unique_buyers_5m: number | null;
  momentum_score: number | null;
  grad_score: number | null;
  rug_score: number | null;
  creator_score: number | null;
  wash_score: number | null;
  dex_vol_m5: number | null;
  dex_buy_sell_ratio: number | null;
  dex_vol_acceleration: number | null;
  dex_price_change_m5: number | null;
  dex_liq_usd: number | null;
};

async function fetchRecentEvaluations(): Promise<Row[]> {
  const res = await getDb().execute(sql`
    WITH recent AS (
      SELECT DISTINCT ON (d.mint)
        d.mint, d.ts, d.action, d.confluence_score, d.module_scores, d.id AS decision_id
      FROM decision_log d
      WHERE d.ts > now() - interval '30 seconds'
      ORDER BY d.mint, d.ts DESC
    )
    SELECT
      r.mint, r.action,
      r.confluence_score::float8 AS confluence_score,
      r.module_scores,
      r.decision_id::text AS decision_id,
      tf.v_sol::float8 AS v_sol,
      tf.curve_progress::float8 AS curve_progress,
      tf.curve_velocity_5m::float8 AS curve_velocity_5m,
      tf.buys_5m, tf.sells_5m, tf.unique_buyers_5m,
      tf.momentum_score::float8 AS momentum_score,
      tf.grad_score::float8 AS grad_score,
      tf.rug_score::float8 AS rug_score,
      tf.creator_score::float8 AS creator_score,
      tf.wash_score::float8 AS wash_score,
      df.vol_m5::float8 AS dex_vol_m5,
      df.buy_sell_ratio::float8 AS dex_buy_sell_ratio,
      df.vol_acceleration::float8 AS dex_vol_acceleration,
      df.price_change_m5::float8 AS dex_price_change_m5,
      df.liq_usd::float8 AS dex_liq_usd
    FROM recent r
    LEFT JOIN LATERAL (
      SELECT * FROM token_features tf WHERE tf.mint = r.mint ORDER BY tf.ts DESC LIMIT 1
    ) tf ON true
    LEFT JOIN dex_features df ON df.mint = r.mint
  `);
  return (res as unknown as { rows: Row[] }).rows;
}

export async function startFeatureSnapshotter() {
  log.info("feature-snapshotter starting", { tickMs: TICK_MS });
  let running = false;

  async function tick() {
    if (running) return;
    running = true;
    const t0 = Date.now();
    touchWorker("feature-snapshotter");
    try {
      const rows = await fetchRecentEvaluations();
      if (rows.length === 0) return;

      const already = await recentlySnapshottedMints("universe", DEDUPE_SEC);
      const staleFlags = snapshotStaleFlags(solUsdFreshness(), dexMarketCacheAgeMs());

      const inputs: FeatureSnapshotInput[] = [];
      for (const r of rows) {
        if (already.has(r.mint)) continue;
        const vSol = r.v_sol ?? null;
        const refMcap =
          vSol != null && vSol > 0 ? mcapUsdFromVSol(vSol) : r.dex_liq_usd ?? null;
        inputs.push({
          mint: r.mint,
          sampleSource: "universe",
          features: {
            v_sol: vSol,
            curve_progress: r.curve_progress,
            curve_velocity_5m: r.curve_velocity_5m,
            buys_5m: r.buys_5m,
            sells_5m: r.sells_5m,
            unique_buyers_5m: r.unique_buyers_5m,
            momentum_score: r.momentum_score,
            grad_score: r.grad_score,
            rug_score: r.rug_score,
            creator_score: r.creator_score,
            wash_score: r.wash_score,
            dex_vol_m5: r.dex_vol_m5,
            dex_buy_sell_ratio: r.dex_buy_sell_ratio,
            dex_vol_acceleration: r.dex_vol_acceleration,
            dex_price_change_m5: r.dex_price_change_m5,
            dex_liq_usd: r.dex_liq_usd,
            module_scores: r.module_scores,
          },
          engineOutputs: {
            action: r.action,
            confluence_score: r.confluence_score,
          },
          staleFlags,
          decisionId: r.decision_id ? BigInt(r.decision_id) : null,
          refVSol: vSol,
          refMcapUsd: refMcap,
        });
      }

      if (inputs.length > 0) {
        const n = await insertFeatureSnapshots(inputs);
        log.debug("snapshotted universe mints", { n, evaluated: rows.length });
      }
    } catch (e) {
      log.warn("feature-snapshotter tick failed", { err: String(e) });
    } finally {
      touchWorker("feature-snapshotter", { tickMs: Date.now() - t0 });
      running = false;
    }
  }

  void tick();
  const id = setInterval(() => void tick(), TICK_MS);
  return async () => clearInterval(id);
}
