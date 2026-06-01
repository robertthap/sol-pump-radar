import "server-only";
import type { EngineBResult } from "@/lib/continuation/types";
import type {
  StateTransition,
  TransitionEmitAction,
} from "@/lib/continuation/state-transition-alerts";

export function mapEngineBActionToLegacy(
  action: EngineBResult["action"],
): "WATCH" | "BUY_MODERATE" | "BUY_STRONG" | "AVOID" | null {
  switch (action) {
    case "ALERT":
    case "WATCH":
      return "WATCH";
    case "CONTINUATION_BUY":
      return "BUY_MODERATE";
    case "EXHAUSTION":
      return "AVOID";
    default:
      return null;
  }
}

export function mapEngineBActionToAlert(action: EngineBResult["action"]): string | null {
  switch (action) {
    case "ALERT":
      return "DEX_TREND_ALERT";
    case "WATCH":
      return "WATCH";
    case "CONTINUATION_BUY":
      return "CONTINUATION_BUY";
    case "EXHAUSTION":
      return "EXHAUSTION_WARNING";
    default:
      return null;
  }
}

/** @deprecated Decisions only via intelligence-commit → commitIntelligenceDecision. */
export async function emitEngineBDecision(_result: EngineBResult): Promise<boolean> {
  return false;
}

/** @deprecated Decisions only via intelligence-commit → commitIntelligenceDecision. */
export async function emitEngineBInterrupt(
  _result: EngineBResult,
  _transition: StateTransition,
  _emitAction: TransitionEmitAction,
): Promise<boolean> {
  return false;
}
