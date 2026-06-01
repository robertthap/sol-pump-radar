import "server-only";

export const ENGINE_B_VERSION = "b1";

export type MomentumState =
  | "cold"
  | "early_breakout"
  | "acceleration"
  | "trend"
  | "parabolic"
  | "exhaustion"
  | "collapse";

export type EngineBAction = "ALERT" | "WATCH" | "CONTINUATION_BUY" | "EXHAUSTION" | "NONE";

export type StatePosterior = { state: MomentumState; confidence: number };

export type NormalizedMintSnapshot = {
  mint: string;
  symbol: string | null;
  alignedTs: number;
  weightedLiqUsd: number;
  unifiedVol: { m5: number; h1: number; h24: number };
  volAcceleration: number;
  poolCount: number;
  poolStabilityFactor: number;
  primaryPool: string;
  primaryDex: string | null;
  priceChangeM5: number | null;
  priceChangeH1: number | null;
  priceChangeH24: number | null;
  buysM5: number;
  sellsM5: number;
  buySellRatio: number;
  singlePoolSpikeFlag: boolean;
};

export type EngineBContext = {
  priorSnapshot?: NormalizedMintSnapshot | null;
  priorRankPercentile?: number | null;
  rankPercentile: number;
  rankVelocity: number;
  eventImpulse: number;
  leadingScore: number;
  universeSize: number;
  /** When true (default), dual-write EngineBTrace after scoring */
  persistTrace?: boolean;
  /** Prior dominant state for transition interrupts (default cold). */
  priorState?: MomentumState;
};

export type EngineBResult = {
  mint: string;
  ts: number;
  engineVersion: typeof ENGINE_B_VERSION;
  state: MomentumState;
  stateConfidence: number;
  statePosterior: StatePosterior[];
  rankPercentile: number;
  rankVelocity: number;
  continuationScore: number;
  probabilities: {
    breakout: number;
    exhaustion: number;
    continuation: number;
  };
  action: EngineBAction;
  reason: string;
  components: {
    rankMomentum: number;
    velocityScore: number;
    stateConfidence: number;
    liquidityQuality: number;
    eventImpulse: number;
    leadingScore: number;
  };
  gateFlags: {
    blockedByExhaustion: boolean;
    blockedByLowBreakout: boolean;
    promotedByBreakout: boolean;
    cappedByParabolic: boolean;
  };
};

export type EngineBTrace = {
  mint: string;
  timestamp: number;
  engineVersion: typeof ENGINE_B_VERSION;
  inputs: {
    normalizedSnapshot: NormalizedMintSnapshot;
    state: MomentumState;
    statePosterior: StatePosterior[];
    rankPercentile: number;
    rankVelocity: number;
    leadingScore?: number;
  };
  outputs: {
    score: number;
    action: EngineBAction;
    probabilities: EngineBResult["probabilities"];
  };
  decisionFactors: {
    rankContribution: number;
    velocityContribution: number;
    stateContribution: number;
    liquidityContribution: number;
    eventContribution: number;
  };
  gateFlags: EngineBResult["gateFlags"];
  finalReason: string;
  timing: DetectionTiming;
};

export type DetectionTiming = {
  firstSeenTs: number | null;
  firstSignalTs: number | null;
  firstRankEntryTs: number | null;
  firstStateTransitionTs: number | null;
  /** First actionable emit (ALERT / CONTINUATION_BUY / STRONG path). */
  firstEntrySignalTs: number | null;
  /** First time dominant state was early_breakout. */
  firstBreakoutDetectedTs: number | null;
  /** First acceleration or CONTINUATION_STRONG-class signal. */
  firstContinuationCandidateTs: number | null;
};

export type MissType =
  | "NOT_IN_UNIVERSE"
  | "NOT_NORMALIZED"
  | "NO_STATE_TRANSITION"
  | "LOW_RANK"
  | "LATE_PARABOLIC"
  | "LATE_STAGE_PARABOLIC"
  | "EVENT_MISSED"
  | "OPS_FAILURE"
  | "GATE_BLOCKED"
  | "GATE_BLOCKED_EXHAUSTION"
  | "GATE_BLOCKED_LOW_BREAKOUT"
  | "NONE";

export type EvalExpectation = "ALERT" | "WATCH" | "NONE";

export type EvalMintDefinition = {
  mint: string;
  symbol: string;
  dexMetricsAtSnapshot?: { h24: number; liqUsd: number };
  expected: EvalExpectation;
};

export type EvalSetSnapshot = {
  version: string;
  marketSnapshotAt: number;
  mints: EvalMintDefinition[];
  expectationPolicy: "forensic_j3";
};

export type EvalMintRow = {
  mint: string;
  symbol: string;
  state: MomentumState;
  rankPercentile: number;
  rankVelocity: number;
  action: EngineBAction;
  reason: string;
  expected: EvalExpectation;
  actual: EngineBAction;
  divergence: "match" | "under_alert" | "over_buy" | "missed_entirely";
  missType?: MissType;
  primaryMissCause?: MissType;
};

export type EvalRunResult = {
  evalSetVersion: string;
  marketSnapshotAt: number;
  runAt: number;
  engineBVersion: string;
  rows: EvalMintRow[];
  summary: { matched: number; missed: number; opsBlocked: number };
};
