import "server-only";
import { logger } from "@/lib/log";
import { readState } from "@/lib/circuit-breaker/state";
import { fuseEngineIntelligence } from "@/lib/intelligence/engine-fusion";
import { readEffectiveAutoGateConfig } from "@/lib/intelligence/auto-gate";
import {
  classifyRegime,
  regimeAdjustedConfig,
  regimeStatsFrom,
  setCurrentRegime,
} from "@/lib/intelligence/regime";
import {
  flushIntelligenceCommits,
  planIntelligenceCommit,
  prioritizePlannedCommits,
  type PlannedCommit,
} from "@/lib/intelligence/commit";
import { getCommitInputBundle } from "@/lib/intelligence/bundle-cache";
import { aggregateDeltaEventsBatch } from "@/lib/intelligence/state-delta-detector";
import { buildCrossMintRanks } from "@/lib/intelligence/dual-engine";
import {
  planMintsToEvaluate,
  noteEvalOutcome,
} from "@/lib/intelligence/eval-scheduler";
import { registerPriorSnapshot } from "@/lib/intelligence/state-delta-detector";
import { touchWorker } from "@/lib/workers/heartbeat";
import { intelEnv } from "@/lib/env";
import { markMintHot } from "@/lib/intelligence/hot-mints";
import {
  moduleScoresFromScoredMint,
  moduleScoresFromValues,
} from "@/lib/intelligence/scored-mint-adapter";
import { fetchLatestModuleScoresBatch } from "@/lib/db/repos/features";
import { getAnalyticsSnapshot } from "@/lib/workers/analytics";
import type { IntelligenceInputSnapshot } from "@/lib/intelligence/types";

const log = logger("intelligence-commit");

export async function startIntelligenceCommit() {
  const cfg = intelEnv();
  log.info("intelligence-commit starting", {
    tickMs: cfg.tickMs,
    universeMax: cfg.universeMax,
    skipUnchangedMs: cfg.skipUnchangedMs,
    maxEvalPerTick: cfg.maxEvaluatePerTick,
    maxCommitsPerTick: cfg.maxCommitsPerTick,
  });
  let running = false;

  async function tick() {
    if (running) return;
    running = true;
    const t0 = Date.now();
    touchWorker("intelligence-commit");
    try {
      const cb = await readState();
      if (cb.state === "HALTED") return;

      const bundle = await getCommitInputBundle();
      if (!bundle.mints.length) {
        touchWorker("intelligence-commit", { tickMs: Date.now() - t0 });
        return;
      }

      const crossTable = buildCrossMintRanks(
        [...bundle.rows.values()].map((r) => r.rank_input),
        bundle.priorRanks,
        0.17,
      );

      const inputs = new Map<string, IntelligenceInputSnapshot>();
      const crossRankPct = new Map<string, number>();
      for (const [mint, row] of bundle.rows) {
        inputs.set(mint, row.input);
        crossRankPct.set(mint, crossTable.get(mint)?.rank_percentile ?? 0.5);
      }

      const deltaBatch = await aggregateDeltaEventsBatch(
        bundle.mints,
        inputs,
        crossRankPct,
      );

      const triggerMeta = new Map<string, { length: number }>();
      for (const [mint, d] of deltaBatch) {
        triggerMeta.set(mint, { length: d.trigger_events.length });
        if (d.trigger_events.length > 0) {
          markMintHot(mint, { score: 0.65, source: "CONTINUATION", ttlMs: 90_000 });
        }
      }

      const plan = planMintsToEvaluate(bundle, crossTable, triggerMeta);

      // Mode + learner-aware gate config, resolved once per tick (cached),
      // then tightened/loosened by the current market regime.
      const baseGateConfig = await readEffectiveAutoGateConfig();
      const regime = classifyRegime(
        regimeStatsFrom(
          [...bundle.rows.values()].map((r) => ({
            ageSeconds: r.input.age_seconds,
            isNewPool: r.input.is_new_pool,
            priceChangeM5: r.input.price_change_m5,
            rug: r.risk_flags?.rug === true,
          })),
        ),
      );
      setCurrentRegime(regime);
      const gateConfig = regimeAdjustedConfig(baseGateConfig, regime);

      const analyticsSnap = getAnalyticsSnapshot();
      const scoredByMint = new Map(
        (analyticsSnap?.scored ?? []).map((s) => [s.mint, s] as const),
      );
      const missingModuleMints = plan.mints.filter((m) => !scoredByMint.has(m));
      const featureModuleByMint = await fetchLatestModuleScoresBatch(missingModuleMints);

      let committed = 0;
      let evaluated = 0;
      const queued: PlannedCommit[] = [];

      for (const mint of plan.mints) {
        const row = bundle.rows.get(mint);
        if (!row) continue;

        const cross = crossTable.get(mint) ?? {
          rank_percentile: 0.5,
          velocity_rank: 0.5,
          liquidity_rank: 0.5,
        };

        const delta = deltaBatch.get(mint) ?? { trigger_events: [], event_impulse: 0 };

        const ctx = {
          cross_mint: cross,
          trigger_events: delta.trigger_events,
          prior_state: row.prior_state,
          prior_rank_percentile: row.prior_rank ?? undefined,
          risk_flags: row.risk_flags,
          in_universe: true,
          normalized: true,
          ops_healthy: true,
          universe_size: bundle.mints.length,
          gateConfig,
        };

        const { output, fusion } = fuseEngineIntelligence(row.input, ctx);
        evaluated++;

        const scored = scoredByMint.get(mint);
        const featureModules = featureModuleByMint.get(mint);
        const moduleScores = scored
          ? moduleScoresFromScoredMint(scored)
          : featureModules
            ? moduleScoresFromValues(featureModules)
            : undefined;
        const planned = await planIntelligenceCommit(output, fusion, {
          confluenceScore: output.confidence,
          input: row.input,
          ...(moduleScores ? { moduleScores } : {}),
        });
        if (planned) queued.push(planned);
        noteEvalOutcome(mint, output);
        registerPriorSnapshot(mint, row.input);
      }

      const { accepted, deferred } = prioritizePlannedCommits(
        queued,
        cfg.maxCommitsPerTick,
      );
      if (deferred.length > 0) {
        log.debug("intelligence commit deferred", { n: deferred.length });
      }
      committed = await flushIntelligenceCommits(accepted);

      const ms = Date.now() - t0;
      if (committed > 0 || ms > cfg.tickMs) {
        log.info("intelligence commit tick", {
          committed,
          evaluated,
          skipped: plan.skipped,
          universe: bundle.mints.length,
          plan: plan.reasons,
          ms,
        });
      }
      touchWorker("intelligence-commit", { tickMs: Date.now() - t0 });
    } catch (e) {
      log.warn("intelligence-commit tick failed", { err: String(e) });
    } finally {
      running = false;
    }
  }

  void tick();
  const id = setInterval(() => void tick(), cfg.tickMs);
  return async () => clearInterval(id);
}
