import "server-only";

import { sql } from "drizzle-orm";

import { logger } from "@/lib/log";

import { isProfitSignalMode, envContinuation } from "@/lib/env";

import { fetchDexMarketBatchCached } from "@/lib/dex/snapshot-cache";
import { emitBusEvent } from "@/lib/arch/event-bus";

import { discoverContinuationMints } from "@/lib/dex/discovery";

import { normalizeDexSnapshot } from "@/lib/dex/normalizer";

import { engineB, engineBAsync } from "@/lib/continuation/engine-b";

import { computeCrossMintRanks, rankInputFromResult } from "@/lib/continuation/cross-mint-rank";

import { mapEngineBActionToAlert } from "@/lib/continuation/emit";
import { processEngineBInterrupt } from "@/lib/continuation/interrupt-pipeline";
import { getPriorState } from "@/lib/continuation/state-registry";

import { classifyArchetype } from "@/lib/continuation/archetype";

import { upsertMintRegistry, upsertPoolRegistry } from "@/lib/db/repos/mint-registry";

import { upsertDexFeatures } from "@/lib/db/repos/dex-features";

import { upsertContinuationCandidate } from "@/lib/db/repos/continuation-candidates";

import { insertDecisionTrace } from "@/lib/db/repos/decision-trace";

import { upsertTrendCandidates } from "@/lib/db/repos/trend-candidates";

import { scoreContinuation } from "@/lib/continuation/score";

import { touchWorker } from "@/lib/workers/heartbeat";

import { getDb } from "@/lib/db/client";

import type { DexMarketSnapshot } from "@/lib/dex/market-snapshot";



const log = logger("continuation-universe");

const TICK_MS = 30_000;

const CHUNK = 25;

const MAX_CHUNKS = 4;



const priorRankCache = new Map<string, number>();



export async function startContinuationUniverse() {

  if (!isProfitSignalMode()) {

    log.info("continuation-universe disabled (SIGNAL_MODE=launch)");

    return () => undefined;

  }



  log.info("continuation-universe starting", { tickMs: TICK_MS });

  let running = false;



  async function tick() {

    if (running) return;

    running = true;
    const t0 = Date.now();

    try {

      const sources = await discoverContinuationMints();

      const mints = [...sources.keys()];

      const markets = new Map<string, DexMarketSnapshot>();



      for (let i = 0; i < Math.min(MAX_CHUNKS, Math.ceil(mints.length / CHUNK)); i++) {

        const slice = mints.slice(i * CHUNK, (i + 1) * CHUNK);

        const batch = await fetchDexMarketBatchCached(slice);

        for (const [m, s] of batch) markets.set(m, s);

      }



      const prepared: Array<{

        mint: string;

        snap: DexMarketSnapshot;

        normalized: ReturnType<typeof normalizeDexSnapshot>;

      }> = [];



      for (const mint of mints) {

        const snap = markets.get(mint);

        if (!snap) {

          await insertDecisionTrace({

            mint,

            stage: "universe_no_dex_pair",

            engine: "B",

            reason: "Dex returned no pairs for mint",

          });

          continue;

        }

        prepared.push({ mint, snap, normalized: normalizeDexSnapshot(snap) });

      }



      const rankInputs = prepared.map(({ mint, normalized }) => {

        const scored = scoreContinuation(

          markets.get(mint)!,

          { rankPercentile: 0.5, rankVelocity: 0 },

        );

        return rankInputFromResult(mint, normalized, {

          continuationScore: scored.continuationScore,

        });

      });



      const ranks = computeCrossMintRanks(rankInputs, priorRankCache, 0.5);

      for (const [m, r] of ranks) priorRankCache.set(m, r.rankPercentile);



      const gates = envContinuation();

      let rank = 0;

      const replayTop: typeof prepared = [];



      for (const { mint, snap, normalized } of prepared) {

        const rankInfo = ranks.get(mint) ?? {

          rankPercentile: 0.5,

          rankVelocity: 0,

          volRankPercentile: 0.5,

          liqRankPercentile: 0.5,

        };



        const { result } = await engineBAsync(mint, normalized, {

          priorSnapshot: null,

          priorRankPercentile: priorRankCache.get(mint) ?? null,

          priorState: getPriorState(mint),

          rankPercentile: rankInfo.rankPercentile,

          rankVelocity: rankInfo.rankVelocity,

          eventImpulse: 0,

          leadingScore: 0,

          universeSize: prepared.length,

          persistTrace: true,

        });

        await processEngineBInterrupt(result, { eventKind: "state_change" });



        rank += 1;

        const legacyScored = scoreContinuation(snap, {

          rankPercentile: result.rankPercentile,

          rankVelocity: result.rankVelocity,

        });



        await upsertMintRegistry(snap, sources.get(mint) ?? "discovery");

        await upsertPoolRegistry(snap);

        await upsertDexFeatures(snap, legacyScored);

        await upsertContinuationCandidate({

          mint,

          continuationScore: result.continuationScore,

          trendRank: rank,

          source: sources.get(mint) ?? "discovery",

          dexH24Pct: snap.priceChangeH24,

          liqUsd: normalized.weightedLiqUsd,

          alertAction: mapEngineBActionToAlert(result.action),

          momentumState: result.state,

          rankPercentile: result.rankPercentile,

          volRankPercentile: rankInfo.volRankPercentile,

          liqRankPercentile: rankInfo.liqRankPercentile,

          rankVelocity: result.rankVelocity,

          stateConfidence: result.stateConfidence,

          pBreakout: result.probabilities.breakout,

          pExhaustion: result.probabilities.exhaustion,

          pContinuation: result.probabilities.continuation,

          engineBAction: result.action,

          engineBJson: result,

        });



        if (result.rankPercentile >= gates.rankEmitPctl) {

          replayTop.push({ mint, snap, normalized });

        }



        await insertDecisionTrace({

          mint,

          stage: "universe_scored",

          engine: "B",

          action: result.action,

          reason: result.reason,

          vetoes: legacyScored.vetoes,

          confidence: result.stateConfidence,

          featureSnapshot: {

            archetype: classifyArchetype(normalized, result),

            engineB: result,

          },

        });



        await upsertTrendCandidates([

          {

            mint,

            vSol: null,

            lastTradeAt: snap.pairCreatedAt?.toISOString() ?? null,

            source: "continuation",

          },

        ]);

      }



      for (const { mint, snap, normalized } of replayTop.slice(0, 30)) {

        const { result } = engineB(mint, normalized, {

          rankPercentile: ranks.get(mint)?.rankPercentile ?? 0.5,

          rankVelocity: ranks.get(mint)?.rankVelocity ?? 0,

          eventImpulse: 0,

          leadingScore: 0,

          universeSize: prepared.length,

          persistTrace: false,

        });

        try {

          await getDb().execute(sql`

            INSERT INTO replay_snapshots (mint, dex_features, continuation_score, alert_action, engine_b_json)

            VALUES (

              ${mint},

              ${JSON.stringify(snap)}::jsonb,

              ${result.continuationScore},

              ${mapEngineBActionToAlert(result.action)},

              ${JSON.stringify(result)}::jsonb

            )

          `);

        } catch {

          /* table optional */

        }

      }



      log.info("continuation universe tick", {

        candidates: prepared.length,

        dexPairs: markets.size,

        top: prepared[0]?.mint?.slice(0, 8),

      });

      emitBusEvent({
        type: "universe:refreshed",
        at: Date.now(),
        candidates: prepared.length,
      });
      touchWorker("continuation-universe", { tickMs: Date.now() - t0 });

    } catch (e) {

      log.warn("continuation-universe tick failed", { err: String(e) });

    } finally {

      running = false;

    }

  }



  void tick();

  const id = setInterval(() => void tick(), TICK_MS);

  return async () => clearInterval(id);
}

