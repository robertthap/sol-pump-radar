import type { IntelligenceEnginePublic, IntelligenceSignalPublic } from "@/lib/intelligence/public-types";
import { stateVisual } from "@/lib/ui/momentum-states";

export function engineBadgeClass(engine: IntelligenceEnginePublic): string {
  return engine === "A"
    ? "border-accent/50 bg-accent/15 text-accent"
    : "border-ok/50 bg-ok/15 text-ok";
}

export function intelligenceSignalLabel(signal: IntelligenceSignalPublic): string {
  switch (signal) {
    case "BUY_STRONG":
      return "Strong";
    case "BUY_MODERATE":
      return "Moderate";
    case "CONTINUATION_BUY":
      return "Cont. buy";
    case "DEX_TREND_ALERT":
      return "Dex alert";
    case "EXHAUSTION_WARNING":
      return "Exhaustion";
    case "WATCH":
      return "Watch";
    case "AVOID":
      return "Avoid";
    default:
      return "—";
  }
}

export function intelligenceSignalClass(signal: IntelligenceSignalPublic): string {
  switch (signal) {
    case "BUY_STRONG":
    case "CONTINUATION_BUY":
      return "border-ok/60 bg-ok/15 text-ok";
    case "BUY_MODERATE":
    case "DEX_TREND_ALERT":
      return "border-accent/50 bg-accent/15 text-accent";
    case "EXHAUSTION_WARNING":
    case "AVOID":
      return "border-bad/50 bg-bad/15 text-bad";
    case "WATCH":
      return "border-border bg-panel text-muted";
    default:
      return "border-border text-muted";
  }
}

export function stateChipClass(state: string): string {
  return stateVisual(state).text;
}
