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
import { mcapUsdFromVSol } from "@/lib/pricing/seam";
import { touchWorker } from "@/lib/workers/heartbeat";
import { dexMarketCacheAgeMs } from "@/lib/dex/snapshot-cache";
import { snapshotStaleFlags } from "@/lib/workers/stale-flags";

/**
 * Upgrade-plan Phase 1, issue #2 — selection-bias control.
 *
 * Features are otherwise only captured for mints the engine actually scores
 * (universe). A model trained on that alone learns "good GIVEN our gates" and is
 * blind to the filtered-out distribution. Each minute this lane randomly snapshots
 * N recently-active mints the universe did NOT evaluate, tagged sample_source
 * 'control'. We'll never trade most of them — but the model needs to see them.
 */
const log = logger("control-sampler");
const TICK_MS = 60_000;
const SAMPLE_N = 10;
const DEDUPE_SEC = 600;

type Row = {
  mint: string;
  buys_5m: number | null;
  sells_5m: number | null;
  unique_buyers_5m: number | null;
  v_sol: number | null;
  age_sec: number | null;
};

async function fetchControlCandidates(limit: number): Promise<Row[]> {
  const res = await getDb().execute(sql`
    WITH evaluated AS (
      SELECT DISTINCT mint FROM decision_log WHERE ts > now() - interval '30 minutes'
    ),
    cand AS (
      SELECT
        e.mint,
        MIN(e.ts) AS first_ts,
        COUNT(*) FILTER (WHERE e.kind = 'buy' AND e.ts > now() - interval '5 minutes')::int AS buys_5m,
        COUNT(*) FILTER (WHERE e.kind = 'sell' AND e.ts > now() - interval '5 minutes')::int AS sells_5m,
        COUNT(DISTINCT e.wallet) FILTER (WHERE e.kind = 'buy' AND e.ts > now() - interval '5 minutes')::int AS unique_buyers_5m,
        (array_agg(e.v_sol_after ORDER BY e.ts DESC) FILTER (WHERE e.v_sol_after IS NOT NULL))[1]::float8 AS v_sol
      FROM events e
      WHERE e.ts > now() - interval '20 minutes'
        AND e.mint IS NOT NULL
        AND e.kind IN ('buy', 'sell', 'create')
      GROUP BY e.mint
    )
    SELECT c.mint, c.buys_5m, c.sells_5m, c.unique_buyers_5m, c.v_sol,
      EXTRACT(EPOCH FROM (now() - c.first_ts))::float8 AS age_sec
    FROM cand c
    WHERE c.mint NOT IN (SELECT mint FROM evaluated)
    ORDER BY random()
    LIMIT ${limit}
  `);
  return (res as unknown as { rows: Row[] }).rows;
}

export async function startControlSampler() {
  log.info("control-sampler starting", { tickMs: TICK_MS, sampleN: SAMPLE_N });
  let running = false;

  async function tick() {
    if (running) return;
    running = true;
    const t0 = Date.now();
    touchWorker("control-sampler");
    try {
      const already = await recentlySnapshottedMints("control", DEDUPE_SEC);
      const rows = await fetchControlCandidates(SAMPLE_N * 3);
      // Same shape as the universe arm so one filter spans both (stale-flags.ts).
      const staleFlags = snapshotStaleFlags(solUsdFreshness(), dexMarketCacheAgeMs());

      const inputs: FeatureSnapshotInput[] = [];
      for (const r of rows) {
        if (inputs.length >= SAMPLE_N) break;
        if (already.has(r.mint)) continue;
        const vSol = r.v_sol ?? null;
        inputs.push({
          mint: r.mint,
          sampleSource: "control",
          features: {
            v_sol: vSol,
            buys_5m: r.buys_5m,
            sells_5m: r.sells_5m,
            unique_buyers_5m: r.unique_buyers_5m,
            age_seconds: r.age_sec,
          },
          engineOutputs: { action: "NONE", confluence_score: null },
          staleFlags,
          refVSol: vSol,
          refMcapUsd: vSol != null && vSol > 0 ? mcapUsdFromVSol(vSol) : null,
        });
      }

      if (inputs.length > 0) {
        const n = await insertFeatureSnapshots(inputs);
        log.debug("snapshotted control mints", { n });
      }
    } catch (e) {
      log.warn("control-sampler tick failed", { err: String(e) });
    } finally {
      touchWorker("control-sampler", { tickMs: Date.now() - t0 });
      running = false;
    }
  }

  void tick();
  const id = setInterval(() => void tick(), TICK_MS);
  return async () => clearInterval(id);
}
