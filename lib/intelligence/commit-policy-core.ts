/** Pure decision_log persistence rules (testable). */

import type { GateSignal } from "@/lib/intelligence/auto-gate-core";

/** Signals that may create decision_log rows (WATCH is trace-only). */
export function shouldPersistDecisionLog(signal: GateSignal): boolean {
  if (signal === "NONE" || signal === "WATCH") return false;
  return (
    signal === "BUY_STRONG" ||
    signal === "BUY_MODERATE" ||
    signal === "CONTINUATION_BUY" ||
    signal === "DEX_TREND_ALERT" ||
    signal === "AVOID" ||
    signal === "EXHAUSTION_WARNING"
  );
}

/** Lower = higher priority when capping commits per tick. */
export function commitPriority(signal: GateSignal): number {
  switch (signal) {
    case "BUY_STRONG":
      return 0;
    case "CONTINUATION_BUY":
      return 1;
    case "BUY_MODERATE":
      return 2;
    case "DEX_TREND_ALERT":
      return 3;
    case "AVOID":
      return 4;
    case "EXHAUSTION_WARNING":
      return 5;
    default:
      return 99;
  }
}
