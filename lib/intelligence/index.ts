export type {
  CrossMintRanks,
  EngineIntelligenceOutput,
  IntelligenceEngine,
  IntelligenceEvaluateContext,
  IntelligenceInputSnapshot,
  IntelligenceMissType,
  IntelligenceRiskFlags,
  IntelligenceSignal,
  TriggerEvent,
  TriggerEventKind,
} from "@/lib/intelligence/types";

export {
  VOL_SPIKE_MULTIPLIER,
  LIQUIDITY_JUMP_PCT,
  RANK_JUMP_PERCENTILE,
  detectTriggerEvents,
  eventImpulseFromTriggers,
} from "@/lib/intelligence/event-triggers";

export {
  aggregateDeltaEvents,
  detectStateDelta,
  registerPriorSnapshot,
  getPriorSnapshot,
  updatePriorSnapshotAfterCommit,
} from "@/lib/intelligence/state-delta-detector";

export {
  intelligenceInputToNormalized,
  engineAEligible,
  engineBEligible,
} from "@/lib/intelligence/normalized-adapter";

export { evaluateEngineA, computeLaunchState, type LaunchState } from "@/lib/intelligence/engine-a-launch";

export { evaluateEngineB, formatEngineBIntelligenceOutput } from "@/lib/intelligence/engine-b-output";

export { fuseEngineIntelligence, type FusionMeta } from "@/lib/intelligence/engine-fusion";

export { computeAutoTradeAllowed, isActionableSignal } from "@/lib/intelligence/auto-gate";

export {
  commitIntelligenceDecision,
  INTELLIGENCE_MODULE_KEY,
  AUTO_TRADE_MODULE_KEY,
  type CommitResult,
} from "@/lib/intelligence/commit";

export {
  loadCommitInputBundle,
  prepareMintEval,
  type CommitInputBundle,
  type MintCommitRow,
  type PreparedMintEval,
} from "@/lib/intelligence/commit-input";

export {
  intelligenceSignalToDecisionAction,
  decideEngineAForUniverse,
  decideEngineAForScoredMint,
  type EngineADecisionBridge,
} from "@/lib/intelligence/decision-bridge";

export {
  scoredMintToIntelligenceInput,
  rankInputFromScoredMint,
  riskFlagsFromScored,
} from "@/lib/intelligence/scored-mint-adapter";

export {
  selectEngine,
  evaluateMintIntelligence,
  evaluateUniverseIntelligence,
  buildCrossMintRanks,
} from "@/lib/intelligence/dual-engine";
