import "server-only";
import type { EngineBAction, EngineBTrace, EvalExpectation, MissType } from "@/lib/continuation/types";

export type MissClassifierInput = {
  mint: string;
  expected: EvalExpectation;
  actual: EngineBAction;
  inUniverse: boolean;
  normalized: boolean;
  traces: EngineBTrace[];
  opsHealthy: boolean;
  dexH24?: number | null;
};

const ALERT_ACTIONS = new Set<EngineBAction>(["ALERT", "CONTINUATION_BUY", "WATCH"]);

function actionMeetsExpected(actual: EngineBAction, expected: EvalExpectation): boolean {
  if (expected === "NONE") return actual === "NONE";
  if (expected === "WATCH") return ALERT_ACTIONS.has(actual);
  if (expected === "ALERT") return actual === "ALERT" || actual === "CONTINUATION_BUY";
  return false;
}

export function classifyMiss(input: MissClassifierInput): MissType {
  if (!input.opsHealthy) return "OPS_FAILURE";
  if (!input.inUniverse) return "NOT_IN_UNIVERSE";
  if (!input.normalized) return "NOT_NORMALIZED";

  const hasAlert = input.traces.some((t) => ALERT_ACTIONS.has(t.outputs.action));
  if (actionMeetsExpected(input.actual, input.expected) || hasAlert) {
    return "NONE";
  }

  const last = input.traces[input.traces.length - 1];
  if (last?.gateFlags.blockedByExhaustion) return "GATE_BLOCKED_EXHAUSTION";
  if (last?.gateFlags.blockedByLowBreakout) return "GATE_BLOCKED_LOW_BREAKOUT";
  if (last?.gateFlags.cappedByParabolic) return "GATE_BLOCKED";

  const dominantCold = input.traces.every((t) => t.inputs.state === "cold");
  if (dominantCold && (input.dexH24 ?? 0) > 25) return "NO_STATE_TRANSITION";

  if (last?.inputs.state === "parabolic" || (input.dexH24 ?? 0) > 400) {
    return "LATE_PARABOLIC";
  }

  if (last && last.inputs.rankPercentile < 0.5) return "LOW_RANK";

  if (input.traces.length === 0) return "EVENT_MISSED";

  return "NO_STATE_TRANSITION";
}

export function divergenceLabel(
  actual: EngineBAction,
  expected: EvalExpectation,
): "match" | "under_alert" | "over_buy" | "missed_entirely" {
  if (actionMeetsExpected(actual, expected)) return "match";
  if (actual === "NONE") return "missed_entirely";
  if (expected === "ALERT" && actual === "WATCH") return "under_alert";
  if (actual === "CONTINUATION_BUY" && expected === "WATCH") return "over_buy";
  return "missed_entirely";
}
