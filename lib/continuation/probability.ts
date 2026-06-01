import "server-only";
import type { NormalizedMintSnapshot } from "@/lib/continuation/types";
import type { MomentumState, StatePosterior } from "@/lib/continuation/types";
import { envContinuation } from "@/lib/env";

function sigmoid(x: number) {
  return 1 / (1 + Math.exp(-x));
}

export function computeProbabilities(input: {
  snap: NormalizedMintSnapshot;
  rankPercentile: number;
  rankVelocity: number;
  statePosterior: StatePosterior[];
  leadingScore: number;
  eventImpulse: number;
  rankMomentum: number;
  velocityScore: number;
  stateConfidence: number;
  liquidityQuality: number;
}): { breakout: number; exhaustion: number; continuation: number } {
  const h24 = input.snap.priceChangeH24 ?? 0;
  const h1 = input.snap.priceChangeH1 ?? 0;
  const dominant = [...input.statePosterior].sort((a, b) => b.confidence - a.confidence)[0]?.state;
  const exhaustionH24 = envContinuation().exhaustionH24;

  const logitCont =
    -0.5 +
    1.2 * input.rankMomentum +
    1.4 * input.rankVelocity +
    1.1 * input.stateConfidence +
    0.8 * input.liquidityQuality +
    0.9 * input.leadingScore -
    0.6 * Math.min(1, input.eventImpulse);

  const pExh = sigmoid(
    -0.3 +
      (h24 > exhaustionH24 ? 1.2 : h24 > exhaustionH24 * 0.5 ? 0.7 : 0) +
      (h1 < -10 ? 0.9 : 0) +
      (input.rankVelocity < -0.08 ? 0.6 : 0) +
      (dominant === "parabolic" ? 0.8 : 0),
  );

  const pBreak = sigmoid(
    -0.4 +
      1.1 * input.leadingScore +
      1.3 * input.rankVelocity +
      0.9 * input.liquidityQuality -
      (input.snap.singlePoolSpikeFlag ? 1.0 : 0) -
      (h24 > exhaustionH24 * 1.25 ? 1.2 : 0),
  );

  const pCont = sigmoid(logitCont) * (1 - pExh * 0.5);

  return {
    breakout: Math.max(0, Math.min(1, pBreak)),
    exhaustion: Math.max(0, Math.min(1, pExh)),
    continuation: Math.max(0, Math.min(1, pCont)),
  };
}

export function stateConfidenceForMomentum(
  posterior: StatePosterior[],
): number {
  const good = new Set<MomentumState>(["early_breakout", "acceleration", "trend"]);
  return posterior.filter((p) => good.has(p.state)).reduce((m, p) => Math.max(m, p.confidence), 0);
}
