import "server-only";

import { autoDemoRelaxEnabled, env } from "@/lib/env";

import { insertDecisions, type DecisionPayload } from "@/lib/db/repos/decisions";

import { insertDecisionTrace } from "@/lib/db/repos/decision-trace";

import { intelligenceSignalToDecisionAction } from "@/lib/intelligence/decision-bridge";

import { isActionableSignal } from "@/lib/intelligence/auto-gate";

import type { EngineIntelligenceOutput, IntelligenceSignal } from "@/lib/intelligence/types";

import type { FusionMeta } from "@/lib/intelligence/engine-fusion";

import { updatePriorSnapshotAfterCommit } from "@/lib/intelligence/state-delta-detector";

import { updateMintStateRegistry } from "@/lib/continuation/state-registry";

import type { MomentumState } from "@/lib/continuation/types";

import { appendIntelligenceTrace } from "@/lib/intelligence/intelligence-jsonl";

import { hasMaterialChange } from "@/lib/intelligence/eval-scheduler";

import { enqueueDbWrite } from "@/lib/db/write-queue";

import { emitBusEvent } from "@/lib/arch/event-bus";
import { solUsdFreshness } from "@/lib/market/sol-usd";

import {

  commitPriority,

  shouldPersistDecisionLog,

} from "@/lib/intelligence/commit-policy-core";

import type { IntelligenceInputSnapshot } from "@/lib/intelligence/types";



const COOLDOWN_MS = 45_000;

const lastCommitByMint = new Map<string, { signal: IntelligenceSignal; at: number }>();



export const INTELLIGENCE_MODULE_KEY = "_intelligence";

export const AUTO_TRADE_MODULE_KEY = "_auto_trade_allowed";



function signalToLegacyAction(signal: IntelligenceSignal): DecisionPayload["action"] | null {

  const mapped = intelligenceSignalToDecisionAction(signal);

  if (mapped) return mapped;

  switch (signal) {

    case "DEX_TREND_ALERT":

      return "BUY_MODERATE";

    case "EXHAUSTION_WARNING":

      return "AVOID";

    case "CONTINUATION_BUY":

      return "BUY_MODERATE";

    default:

      return null;

  }

}



export type CommitResult = {

  committed: boolean;

  skippedReason?: string;

  decisionId?: bigint;

};



export type PlannedCommit = {

  output: EngineIntelligenceOutput;

  fusion: FusionMeta;

  payload: DecisionPayload;

  legacyAction: DecisionPayload["action"];

  input?: IntelligenceInputSnapshot;

};



export type PlanCommitOpts = {

  confluenceScore?: number;

  moduleScores?: Record<string, number>;

  input?: IntelligenceInputSnapshot;

};



/**

 * Evaluate whether this mint should enter the tick's decision_log batch.

 * Traces / prior snapshots for non-commits are handled here; DB flush is batched.

 */

export async function planIntelligenceCommit(

  output: EngineIntelligenceOutput,

  fusion: FusionMeta,

  opts?: PlanCommitOpts,

): Promise<PlannedCommit | null> {

  const now = Date.now();

  const last = lastCommitByMint.get(output.mint);

  if (last && last.signal === output.signal && now - last.at < COOLDOWN_MS) {

    return null;

  }



  if (!isActionableSignal(output.signal) || output.signal === "NONE") {

    fireTracesJsonl(output, fusion, null, false);

    if (opts?.input) updatePriorSnapshotAfterCommit(output.mint, opts.input);

    return null;

  }



  const action = signalToLegacyAction(output.signal);

  if (!action) {

    return null;

  }



  const material = hasMaterialChange(output.mint, output);

  const persistLog = shouldPersistDecisionLog(output.signal);



  if (!persistLog || !material) {

    fireTracesJsonl(output, fusion, action, false);

    if (opts?.input) updatePriorSnapshotAfterCommit(output.mint, opts.input);

    return null;

  }



  const relaxAutoQueue = autoDemoRelaxEnabled();
  const buyAction = action.startsWith("BUY");
  const queueForAuto =
    buyAction && (output.auto_trade_allowed || relaxAutoQueue);

  const moduleScores: Record<string, number> = {

    ...(opts?.moduleScores ?? {}),

    [INTELLIGENCE_MODULE_KEY]: output.confidence,

    [AUTO_TRADE_MODULE_KEY]: queueForAuto ? 1 : output.auto_trade_allowed ? 1 : 0,
    // Strict gate result, independent of AUTO_DEMO_RELAX queueing. Lets the
    // auto-trader run a strict-first pass and tag entry_tier for the learner.
    _strict_allowed: output.auto_trade_allowed ? 1 : 0,
    _engine_a: output.engine === "A" ? 1 : 0,

  };
  const liqUsd = opts?.input?.liquidity_usd;
  if (liqUsd != null && liqUsd > 0 && !(Number(moduleScores._v_sol) > 0)) {
    // _v_sol is derived from a USD figure, so it inherits the SOL/USD basis. The
    // auto-trader already skips ENTRIES while that price is on its fallback, but
    // the DECISION is still written to decision_log and flows into
    // feature_snapshots — so stamp the freshness and keep contaminated rows
    // filterable later (same idea as outcome_labels.blocked_reason).
    // Gating is deliberately unchanged: this only labels, it never rejects.
    const sol = solUsdFreshness();
    moduleScores._v_sol = liqUsd / sol.usd;
    moduleScores._sol_usd_stale = sol.fresh ? 0 : 1;
  }

  const executed = queueForAuto ? "pending" : buyAction ? "skipped" : "pending";

  const payload: DecisionPayload = {

    mint: output.mint,

    action,

    confluenceScore: opts?.confluenceScore ?? output.confidence,

    threshold: 0.38,

    modulesFired: ["ENGINE_INTELLIGENCE", `ENGINE_${output.engine}`],

    moduleScores,

    vetoes: output.miss_type ? [`miss:${output.miss_type}`] : [],

    reasonHuman: output.reason.slice(0, 500),

    mode: env().TRADER_MODE,

    executed,

    executorReason: queueForAuto
      ? relaxAutoQueue && !output.auto_trade_allowed
        ? "demo_relax_queued"
        : undefined
      : buyAction
        ? "auto_trade_blocked"
        : undefined,

  };



  return { output, fusion, payload, legacyAction: action, input: opts?.input };

}



/** Sort by signal priority and persist decision_log + traces in two queue jobs. */

export async function flushIntelligenceCommits(planned: PlannedCommit[]): Promise<number> {

  if (planned.length === 0) return 0;



  const now = Date.now();

  const payloads = planned.map((p) => p.payload);



  await enqueueDbWrite("decision_log", () => insertDecisions(payloads));



  for (const p of planned) {

    lastCommitByMint.set(p.output.mint, { signal: p.output.signal, at: now });

  }



  await enqueueDbWrite("decision_trace", async () => {

    for (const p of planned) {

      await insertDecisionTrace({

        mint: p.output.mint,

        stage: "intelligence_commit",

        engine: p.output.engine,

        action: p.legacyAction,

        reason: p.output.reason.slice(0, 500),

        confidence: p.output.confidence,

        featureSnapshot: {

          output: p.output,

          fusion: {

            winner: p.fusion.winner,

            fusionReason: p.fusion.fusionReason,

          },

        },

      });

    }

  });



  for (const p of planned) {

    void appendIntelligenceTrace({

      output: p.output,

      fusion: p.fusion,

      legacyAction: p.legacyAction,

      committed: true,

    }).catch(() => undefined);



    emitBusEvent({

      type: "intel:committed",

      at: now,

      mint: p.output.mint,

      signal: p.output.signal,

    });



    updatePriorSnapshotAfterCommit(

      p.output.mint,

      p.input ?? buildSnapshotFromOutput(p.output),

    );

    updateMintStateRegistry(

      p.output.mint,

      p.output.state as MomentumState,

      p.output.rank_percentile,

      now,

    );

  }



  return planned.length;

}



export function prioritizePlannedCommits(

  planned: PlannedCommit[],

  maxCommits: number,

): { accepted: PlannedCommit[]; deferred: PlannedCommit[] } {

  const sorted = [...planned].sort(

    (a, b) =>

      commitPriority(a.output.signal) - commitPriority(b.output.signal) ||

      b.output.rank_percentile - a.output.rank_percentile,

  );

  return {

    accepted: sorted.slice(0, maxCommits),

    deferred: sorted.slice(maxCommits),

  };

}



/**

 * Sole authority for decision_log, traces, and auto-trade pending flag.

 */

export async function commitIntelligenceDecision(

  output: EngineIntelligenceOutput,

  fusion: FusionMeta,

  opts?: PlanCommitOpts,

): Promise<CommitResult> {

  const planned = await planIntelligenceCommit(output, fusion, opts);

  if (!planned) {

    return { committed: false, skippedReason: "no_commit" };

  }

  const n = await flushIntelligenceCommits([planned]);

  return { committed: n > 0 };

}



function buildSnapshotFromOutput(output: EngineIntelligenceOutput) {

  return {

    mint: output.mint,

    age_seconds: 3600,

    liquidity_usd: 10_000,

    volume_m5: 0,

    volume_m30: 0,

    volume_h1: 0,

    price_change_m1: 0,

    price_change_m5: 0,

    price_change_h1: 0,

    buy_sell_ratio: 0.5,

    unique_wallets_5m: 0,

    unique_wallets_30m: 0,

    holder_growth: 0,

    pool_count: 1,

    dex_rank: null,

    is_new_pool: false,

    migration_status: "dex" as const,

  };

}



/** JSONL only — never blocks the intelligence-commit tick loop. */
function fireTracesJsonl(
  output: EngineIntelligenceOutput,
  fusion: FusionMeta,
  legacyAction: string | null,
  committed: boolean,
) {
  const material = committed || hasMaterialChange(output.mint, output);
  if (!material) return;
  void appendIntelligenceTrace({ output, fusion, legacyAction, committed }).catch(() => undefined);
}

/** JSONL on material change; DB trace optional to avoid write storms. */
async function maybeWriteTraces(

  output: EngineIntelligenceOutput,

  fusion: FusionMeta,

  legacyAction: string | null,

  committed: boolean,

  opts?: { pgTrace?: boolean },

) {

  const material = committed || hasMaterialChange(output.mint, output);

  if (!material) return;



  void appendIntelligenceTrace({ output, fusion, legacyAction, committed }).catch(() => undefined);



  if (opts?.pgTrace === false) return;



  await enqueueDbWrite("decision_trace", () =>

    insertDecisionTrace({

      mint: output.mint,

      stage: "intelligence_commit",

      engine: output.engine,

      action: legacyAction ?? output.signal,

      reason: output.reason.slice(0, 500),

      confidence: output.confidence,

      featureSnapshot: {

        output,

        fusion: { winner: fusion.winner, fusionReason: fusion.fusionReason },

      },

    }),

  );

}


