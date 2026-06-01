import "server-only";
import type {
  EngineIntelligenceOutput,
  IntelligenceEngine,
  IntelligenceInputSnapshot,
  IntelligenceMissType,
  IntelligenceSignal,
} from "@/lib/intelligence/types";
import { engineAEligible, engineBEligible } from "@/lib/intelligence/normalized-adapter";
import { evaluateEngineA } from "@/lib/intelligence/engine-a-launch";
import { evaluateEngineB } from "@/lib/intelligence/engine-b-output";
import { computeAutoTradeAllowed, currentSignalMode } from "@/lib/intelligence/auto-gate";
import { defaultGateConfig } from "@/lib/intelligence/gate-config";
import type { IntelligenceEvaluateContext } from "@/lib/intelligence/types";
import { fuseMissTypeCore, pickFusionWinner } from "@/lib/intelligence/engine-fusion-core";

export type FusionMeta = {
  candidateA: EngineIntelligenceOutput | null;
  candidateB: EngineIntelligenceOutput | null;
  winner: IntelligenceEngine;
  fusionReason: string;
};

function toFusionCandidate(out: EngineIntelligenceOutput, engine: IntelligenceEngine) {
  return {
    mint: out.mint,
    engine,
    state: out.state,
    signal: out.signal,
    confidence: out.confidence,
    rank_percentile: out.rank_percentile,
    miss_type: out.miss_type,
  };
}

function pickWinner(
  a: EngineIntelligenceOutput | null,
  b: EngineIntelligenceOutput | null,
): { winner: EngineIntelligenceOutput; meta: FusionMeta } {
  const picked = pickFusionWinner(
    a ? toFusionCandidate(a, "A") : null,
    b ? toFusionCandidate(b, "B") : null,
  );
  if (!a && !b) {
    const empty: EngineIntelligenceOutput = {
      mint: "",
      engine: "B",
      state: "cold",
      rank_percentile: 0,
      signal: "NONE",
      auto_trade_allowed: false,
      confidence: 0,
      reason: "fusion=no_candidates",
      trigger_events: [],
      miss_type: "NOT_IN_UNIVERSE",
    };
    return {
      winner: empty,
      meta: { candidateA: a, candidateB: b, winner: "B", fusionReason: picked.reason },
    };
  }
  const source = picked.engine === "A" ? a! : b!;
  return {
    winner: { ...source, engine: picked.engine },
    meta: {
      candidateA: a,
      candidateB: b,
      winner: picked.engine,
      fusionReason: picked.reason,
    },
  };
}

/** Run A+B scorers and fuse to single deterministic output. */
export function fuseEngineIntelligence(
  input: IntelligenceInputSnapshot,
  ctx: IntelligenceEvaluateContext,
): { output: EngineIntelligenceOutput; fusion: FusionMeta } {
  // Resolve once and reuse for both the signal scorer (Engine A) and the final
  // auto-trade gate so they apply identical mode/learner-aware floors.
  const gateConfig = ctx.gateConfig ?? defaultGateConfig(currentSignalMode());

  const candidateA = engineAEligible(input)
    ? evaluateEngineA(input, { ...ctx, engine: "A", gateConfig })
    : null;
  const candidateB = engineBEligible(input)
    ? evaluateEngineB(input, { ...ctx, engine: "B", gateConfig })
    : null;

  const { winner, meta } = pickWinner(candidateA, candidateB);
  const trigger_events =
    ctx.trigger_events ??
    winner.trigger_events ??
    candidateA?.trigger_events ??
    candidateB?.trigger_events ??
    [];

  const auto_trade_allowed = computeAutoTradeAllowed(
    { ...winner, trigger_events },
    input,
    ctx.risk_flags,
    gateConfig,
  );

  const output: EngineIntelligenceOutput = {
    ...winner,
    mint: input.mint,
    trigger_events,
    auto_trade_allowed,
    miss_type: fuseMissTypeCore(
      toFusionCandidate(winner, meta.winner),
      candidateA ? toFusionCandidate(candidateA, "A") : null,
      candidateB ? toFusionCandidate(candidateB, "B") : null,
    ) as IntelligenceMissType | null,
    reason: [
      winner.reason,
      `fusion=${meta.fusionReason}`,
      meta.candidateA ? `A=${meta.candidateA.signal}` : "A=skip",
      meta.candidateB ? `B=${meta.candidateB.signal}` : "B=skip",
    ]
      .join("|")
      .slice(0, 500),
  };

  return { output, fusion: meta };
}
