import "server-only";
import type { EngineBAction, EngineBResult, MomentumState } from "@/lib/continuation/types";
import { touchDetectionTiming } from "@/lib/continuation/detection-timing";
import { RANK_JUMP_PERCENTILE } from "@/lib/intelligence/event-triggers";

export type TransitionEmitAction =
  | "ALERT"
  | "CONTINUATION_STRONG"
  | "CONTINUATION_BUY"
  | "WATCH"
  | "EXHAUSTION"
  | "NONE";

export type StateTransition = {
  from: MomentumState;
  to: MomentumState;
  kind: "state_change" | "rank_jump" | "event_spike";
};

const EMIT_RANK_FLOOR = 0.45;
const STRONG_RANK_FLOOR = 0.65;

/** Actionable transitions — emit at boundary, not after parabolic. */
const TRANSITION_RULES: Array<{
  from: MomentumState | "*";
  to: MomentumState;
  action: TransitionEmitAction;
  minRank: number;
  minBreakout: number;
}> = [
  { from: "cold", to: "early_breakout", action: "ALERT", minRank: EMIT_RANK_FLOOR, minBreakout: 0.52 },
  { from: "early_breakout", to: "acceleration", action: "CONTINUATION_STRONG", minRank: STRONG_RANK_FLOOR, minBreakout: 0.58 },
  { from: "early_breakout", to: "trend", action: "ALERT", minRank: EMIT_RANK_FLOOR, minBreakout: 0.55 },
  { from: "acceleration", to: "trend", action: "CONTINUATION_BUY", minRank: STRONG_RANK_FLOOR, minBreakout: 0.62 },
  { from: "trend", to: "acceleration", action: "ALERT", minRank: EMIT_RANK_FLOOR, minBreakout: 0.55 },
];

export function detectStateTransition(
  prior: MomentumState,
  next: MomentumState,
): StateTransition | null {
  if (prior === next) return null;
  return { from: prior, to: next, kind: "state_change" };
}

export function resolveTransitionEmit(
  transition: StateTransition,
  result: EngineBResult,
): TransitionEmitAction {
  const pBreak = result.probabilities.breakout;
  const pExh = result.probabilities.exhaustion;
  const rank = result.rankPercentile;

  if (
    transition.kind === "rank_jump" &&
    rank >= Math.max(STRONG_RANK_FLOOR, 0.5 + RANK_JUMP_PERCENTILE) &&
    pBreak >= 0.55
  ) {
    return pExh > 0.7 ? "WATCH" : "ALERT";
  }

  if (transition.kind === "event_spike" && result.state === "early_breakout" && rank >= EMIT_RANK_FLOOR) {
    return pExh > 0.65 ? "WATCH" : "ALERT";
  }

  for (const rule of TRANSITION_RULES) {
    if (rule.to !== transition.to) continue;
    if (rule.from !== "*" && rule.from !== transition.from) continue;
    if (rank < rule.minRank || pBreak < rule.minBreakout) continue;
    if (pExh > 0.72 && rule.action !== "WATCH" && rule.action !== "EXHAUSTION") {
      return "WATCH";
    }
    return rule.action;
  }

  if (transition.to === "parabolic" || transition.to === "exhaustion") {
    return pExh > 0.7 ? "EXHAUSTION" : "WATCH";
  }

  return "NONE";
}

/** First-sight / snapshot eval: promote early states without prior transition history. */
export function applyIntrinsicEarlyEntry(result: EngineBResult): EngineBResult {
  if (result.action === "ALERT" || result.action === "CONTINUATION_BUY") return result;

  const pBreak = result.probabilities.breakout;
  const pExh = result.probabilities.exhaustion;

  if (
    result.state === "early_breakout" &&
    result.rankPercentile >= 0.55 &&
    pBreak >= 0.52 &&
    pExh < 0.65
  ) {
    touchDetectionTiming(result.mint, { firstBreakout: true, entrySignal: "ALERT" }, result.ts);
    return {
      ...result,
      action: "ALERT",
      reason: `${result.reason}|intrinsic=early_breakout_entry`,
    };
  }

  if (
    result.state === "acceleration" &&
    result.rankPercentile >= 0.65 &&
    pBreak >= 0.58 &&
    pExh < 0.55
  ) {
    touchDetectionTiming(
      result.mint,
      { continuationCandidate: true, entrySignal: "CONTINUATION_BUY" },
      result.ts,
    );
    return {
      ...result,
      action: "CONTINUATION_BUY",
      reason: `${result.reason}|intrinsic=acceleration_entry`,
    };
  }

  return result;
}

/** Override snapshot action when transition warrants earlier emission. */
export function applyTransitionActionOverride(
  prior: MomentumState,
  result: EngineBResult,
  transition: StateTransition | null,
): EngineBResult {
  if (!transition) return result;

  const emit = resolveTransitionEmit(transition, result);
  if (emit === "NONE") return result;

  const lateOnly =
    result.state === "parabolic" || result.state === "exhaustion" || result.state === "collapse";
  const earlyTransition =
    transition.to === "early_breakout" ||
    transition.to === "acceleration" ||
    transition.to === "trend";

  if (lateOnly && !earlyTransition && result.action !== "NONE") {
    return result;
  }

  const actionMap: Record<TransitionEmitAction, EngineBAction> = {
    ALERT: "ALERT",
    CONTINUATION_STRONG: "CONTINUATION_BUY",
    CONTINUATION_BUY: "CONTINUATION_BUY",
    WATCH: "WATCH",
    EXHAUSTION: "EXHAUSTION",
    NONE: "NONE",
  };

  const newAction = actionMap[emit];
  if (newAction === result.action) return result;

  const now = Date.now();
  if (transition.to === "early_breakout") {
    touchDetectionTiming(result.mint, { firstBreakout: true, entrySignal: newAction }, now);
  }
  if (transition.to === "acceleration" || emit === "CONTINUATION_STRONG") {
    touchDetectionTiming(result.mint, { continuationCandidate: true, entrySignal: newAction }, now);
  }
  touchDetectionTiming(result.mint, { entrySignal: newAction }, now);

  return {
    ...result,
    action: newAction,
    reason: `${result.reason}|interrupt=${transition.from}→${transition.to}|emit=${emit}`,
  };
}
