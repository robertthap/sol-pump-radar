import "server-only";
import type {
  EngineBAction,
  EngineBResult,
  MomentumState,
  NormalizedMintSnapshot,
} from "@/lib/continuation/types";
import { envContinuation } from "@/lib/env";

export function computeScoreB(components: {
  rankMomentum: number;
  velocityScore: number;
  stateConfidence: number;
  liquidityQuality: number;
  eventImpulse: number;
}): number {
  return (
    0.35 * components.rankMomentum +
    0.25 * components.velocityScore +
    0.2 * components.stateConfidence +
    0.15 * components.liquidityQuality +
    0.05 * components.eventImpulse
  );
}

export function applyProbabilityGates(input: {
  scoreB: number;
  rankPercentile: number;
  dominantState: MomentumState;
  probabilities: EngineBResult["probabilities"];
}): { action: EngineBAction; gateFlags: EngineBResult["gateFlags"] } {
  const gates = envContinuation();
  const pExh = input.probabilities.exhaustion;
  const pBreak = input.probabilities.breakout;

  const lateDominant =
    input.dominantState === "parabolic" ||
    input.dominantState === "exhaustion" ||
    input.dominantState === "collapse";

  const gateFlags: EngineBResult["gateFlags"] = {
    blockedByExhaustion: pExh > gates.exhaustionBlock,
    blockedByLowBreakout: pBreak < 0.5,
    promotedByBreakout: pBreak > gates.breakoutAlert,
    cappedByParabolic: input.dominantState === "parabolic",
  };

  let action: EngineBAction = "NONE";

  if (
    (gateFlags.blockedByExhaustion || gateFlags.cappedByParabolic) &&
    lateDominant
  ) {
    action = pExh > 0.85 ? "EXHAUSTION" : "WATCH";
    return { action, gateFlags };
  }

  if (gateFlags.blockedByLowBreakout) {
    action = input.scoreB > gates.alertScore * 0.66 ? "WATCH" : "NONE";
    return { action, gateFlags };
  }

  if (
    pBreak > gates.breakoutBuy &&
    input.rankPercentile > gates.rankBuyMin &&
    pExh < 0.5
  ) {
    action = "CONTINUATION_BUY";
  } else if (pBreak > gates.breakoutAlert) {
    action = "ALERT";
  } else if (input.scoreB > gates.buyScore * 0.54) {
    action = "WATCH";
  }

  return { action, gateFlags };
}

export function liquidityQuality(snap: NormalizedMintSnapshot): number {
  const minLiq = envContinuation().minLiqUsd;
  const base = Math.min(1, snap.weightedLiqUsd / minLiq);
  return base * snap.poolStabilityFactor;
}

export function velocityScore(rankVelocity: number, universeP95 = 0.15): number {
  return Math.min(1, Math.max(0, rankVelocity / universeP95));
}

export function rankMomentumFromPercentile(rankPercentile: number): number {
  return Math.max(0, Math.min(1, rankPercentile));
}
