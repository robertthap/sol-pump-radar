import "server-only";
import {
  ENGINE_B_VERSION,
  type EngineBContext,
  type EngineBResult,
  type NormalizedMintSnapshot,
} from "@/lib/continuation/types";
import { computeStatePosterior, dominantState } from "@/lib/continuation/momentum-state";
import { computeLeadingScore } from "@/lib/continuation/leading-signals";
import {
  computeProbabilities,
  stateConfidenceForMomentum,
} from "@/lib/continuation/probability";
import {
  applyProbabilityGates,
  computeScoreB,
  liquidityQuality,
  rankMomentumFromPercentile,
  velocityScore,
} from "@/lib/continuation/fusion";
import { buildEngineBTrace } from "@/lib/continuation/engine-b-trace";
import { persistEngineBTrace } from "@/lib/continuation/trace-store";
import { touchDetectionTiming } from "@/lib/continuation/detection-timing";
import { getPriorState } from "@/lib/continuation/state-registry";
import {
  applyIntrinsicEarlyEntry,
  applyTransitionActionOverride,
  detectStateTransition,
} from "@/lib/continuation/state-transition-alerts";

export type EngineBRun = { result: EngineBResult; trace: ReturnType<typeof buildEngineBTrace> };

export async function engineBAsync(
  mint: string,
  snapshot: NormalizedMintSnapshot,
  ctx: EngineBContext,
): Promise<EngineBRun> {
  const run = engineB(mint, snapshot, ctx);
  if (ctx.persistTrace !== false) {
    await persistEngineBTrace(run.trace);
  }
  return run;
}

export function engineB(
  mint: string,
  snapshot: NormalizedMintSnapshot,
  ctx: EngineBContext,
): EngineBRun {
  const leadingScore = ctx.leadingScore ?? computeLeadingScore(snapshot, ctx.priorSnapshot);
  const posterior = computeStatePosterior(snapshot, {
    leadingScore,
    rankVelocity: ctx.rankVelocity,
  });
  const dom = dominantState(posterior);

  const liqQ = liquidityQuality(snapshot);
  const rankMom = rankMomentumFromPercentile(ctx.rankPercentile);
  const velSc = velocityScore(ctx.rankVelocity);
  const stateConf = stateConfidenceForMomentum(posterior);

  const components = {
    rankMomentum: rankMom,
    velocityScore: velSc,
    stateConfidence: stateConf,
    liquidityQuality: liqQ,
    eventImpulse: Math.min(1, ctx.eventImpulse),
    leadingScore,
  };

  const probabilities = computeProbabilities({
    snap: snapshot,
    rankPercentile: ctx.rankPercentile,
    rankVelocity: ctx.rankVelocity,
    statePosterior: posterior,
    leadingScore,
    eventImpulse: ctx.eventImpulse,
    rankMomentum: rankMom,
    velocityScore: velSc,
    stateConfidence: stateConf,
    liquidityQuality: liqQ,
  });

  const continuationScore = computeScoreB(components);
  const { action: gatedAction, gateFlags } = applyProbabilityGates({
    scoreB: continuationScore,
    rankPercentile: ctx.rankPercentile,
    dominantState: dom.state,
    probabilities,
  });

  const priorState = ctx.priorState ?? getPriorState(mint);
  const transition = detectStateTransition(priorState, dom.state);

  let action = gatedAction;
  let resultDraft: EngineBResult = {
    mint,
    ts: Date.now(),
    engineVersion: ENGINE_B_VERSION,
    state: dom.state,
    stateConfidence: dom.confidence,
    statePosterior: posterior,
    rankPercentile: ctx.rankPercentile,
    rankVelocity: ctx.rankVelocity,
    continuationScore,
    probabilities,
    action: gatedAction,
    reason: "",
    components,
    gateFlags,
  };

  resultDraft = applyIntrinsicEarlyEntry(resultDraft);
  resultDraft = applyTransitionActionOverride(priorState, resultDraft, transition);
  action = resultDraft.action;

  const reason = [
    `engine=B`,
    `state=${dom.state}:${dom.confidence.toFixed(2)}`,
    `rank=${ctx.rankPercentile.toFixed(2)}`,
    `rankVel=${ctx.rankVelocity.toFixed(3)}/min`,
    `score=${continuationScore.toFixed(2)}`,
    `P_break=${probabilities.breakout.toFixed(2)}`,
    `P_exh=${probabilities.exhaustion.toFixed(2)}`,
    `action=${action}`,
  ].join("|");

  const result: EngineBResult = {
    ...resultDraft,
    reason,
  };

  touchDetectionTiming(mint, {
    seen: true,
    signalAction: result.action,
    rankPercentile: ctx.rankPercentile,
    state: dom.state,
  }, result.ts);

  const trace = buildEngineBTrace(result, snapshot, posterior, leadingScore);
  return { result, trace };
}
