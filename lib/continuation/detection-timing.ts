import "server-only";
import type { DetectionTiming, EngineBAction, MomentumState } from "@/lib/continuation/types";
import { envContinuation } from "@/lib/env";

export type { DetectionTiming };

const SIGNAL_ACTIONS = new Set<EngineBAction>(["ALERT", "CONTINUATION_BUY", "WATCH", "EXHAUSTION"]);

const byMint = new Map<string, DetectionTiming>();

function empty(): DetectionTiming {
  return {
    firstSeenTs: null,
    firstSignalTs: null,
    firstRankEntryTs: null,
    firstStateTransitionTs: null,
    firstEntrySignalTs: null,
    firstBreakoutDetectedTs: null,
    firstContinuationCandidateTs: null,
  };
}

export function getDetectionTiming(mint: string): DetectionTiming {
  return byMint.get(mint) ?? empty();
}

export function touchDetectionTiming(
  mint: string,
  update: {
    seen?: boolean;
    signalAction?: EngineBAction;
    entrySignal?: EngineBAction;
    rankPercentile?: number;
    state?: MomentumState;
    firstBreakout?: boolean;
    continuationCandidate?: boolean;
  },
  now = Date.now(),
): DetectionTiming {
  const cur = { ...(byMint.get(mint) ?? empty()) };

  if (update.seen && cur.firstSeenTs == null) cur.firstSeenTs = now;

  if (
    update.signalAction &&
    SIGNAL_ACTIONS.has(update.signalAction) &&
    update.signalAction !== "NONE" &&
    cur.firstSignalTs == null
  ) {
    cur.firstSignalTs = now;
  }

  const rankFloor = envContinuation().rankEmitPctl;
  if (
    update.rankPercentile != null &&
    update.rankPercentile >= rankFloor &&
    cur.firstRankEntryTs == null
  ) {
    cur.firstRankEntryTs = now;
  }

  if (
    update.state &&
    update.state !== "cold" &&
    cur.firstStateTransitionTs == null
  ) {
    cur.firstStateTransitionTs = now;
  }

  if (update.firstBreakout || update.state === "early_breakout") {
    if (cur.firstBreakoutDetectedTs == null) cur.firstBreakoutDetectedTs = now;
  }

  if (update.continuationCandidate || update.state === "acceleration") {
    if (cur.firstContinuationCandidateTs == null) cur.firstContinuationCandidateTs = now;
  }

  const entry = update.entrySignal ?? update.signalAction;
  if (
    entry &&
    SIGNAL_ACTIONS.has(entry) &&
    entry !== "NONE" &&
    (entry === "ALERT" || entry === "CONTINUATION_BUY") &&
    cur.firstEntrySignalTs == null
  ) {
    cur.firstEntrySignalTs = now;
  }

  byMint.set(mint, cur);
  return cur;
}

export function detectionAdvantageMs(timing: DetectionTiming): number | null {
  if (timing.firstSignalTs == null) return null;
  if (timing.firstSeenTs == null) return 0;
  return timing.firstSignalTs - timing.firstSeenTs;
}
