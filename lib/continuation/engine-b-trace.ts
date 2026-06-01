import "server-only";
import {
  ENGINE_B_VERSION,
  type EngineBResult,
  type EngineBTrace,
  type NormalizedMintSnapshot,
  type StatePosterior,
} from "@/lib/continuation/types";
import {
  computeScoreB,
  rankMomentumFromPercentile,
  velocityScore,
} from "@/lib/continuation/fusion";
import { stateConfidenceForMomentum } from "@/lib/continuation/probability";
import { getDetectionTiming } from "@/lib/continuation/detection-timing";

export function buildEngineBTrace(
  result: EngineBResult,
  snapshot: NormalizedMintSnapshot,
  statePosterior: StatePosterior[],
  leadingScore: number,
): EngineBTrace {
  const rankMom = rankMomentumFromPercentile(result.rankPercentile);
  const velSc = velocityScore(result.rankVelocity);
  const stateConf = stateConfidenceForMomentum(statePosterior);

  const decisionFactors = {
    rankContribution: 0.35 * rankMom,
    velocityContribution: 0.25 * velSc,
    stateContribution: 0.2 * stateConf,
    liquidityContribution: 0.15 * result.components.liquidityQuality,
    eventContribution: 0.05 * result.components.eventImpulse,
  };

  return {
    mint: result.mint,
    timestamp: result.ts,
    engineVersion: ENGINE_B_VERSION,
    inputs: {
      normalizedSnapshot: snapshot,
      state: result.state,
      statePosterior,
      rankPercentile: result.rankPercentile,
      rankVelocity: result.rankVelocity,
      leadingScore,
    },
    outputs: {
      score: result.continuationScore,
      action: result.action,
      probabilities: result.probabilities,
    },
    decisionFactors,
    gateFlags: result.gateFlags,
    finalReason: result.reason,
    timing: getDetectionTiming(result.mint),
  };
}

/** Verify trace matches result score decomposition */
export function traceScoreCheck(trace: EngineBTrace): number {
  const c = trace.decisionFactors;
  return c.rankContribution + c.velocityContribution + c.stateContribution + c.liquidityContribution + c.eventContribution;
}
