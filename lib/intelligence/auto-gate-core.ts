/** Pure auto-trade gate (testable, no server-only). */
import { defaultGateConfig, type AutoGateConfig } from "@/lib/intelligence/gate-config";

export type GateSignal =
  | "BUY_STRONG"
  | "BUY_MODERATE"
  | "CONTINUATION_BUY"
  | "DEX_TREND_ALERT"
  | "WATCH"
  | "AVOID"
  | "EXHAUSTION_WARNING"
  | "NONE";

export type GateOutput = {
  engine: "A" | "B";
  state: string;
  rank_percentile: number;
  signal: GateSignal;
  confidence: number;
  trigger_events: Array<{ kind: string }>;
  /** Launch-velocity score [0..1]; undefined → treated as passing (1). */
  velocity_score?: number;
};

export type GateInput = {
  liquidity_usd: number;
  price_change_h1: number;
};

export type GateRisk = { rug?: boolean; bundle?: boolean; insider?: boolean };

export function computeAutoTradeAllowedCore(
  output: GateOutput,
  input: GateInput,
  risk: GateRisk = {},
  /** Defaults to conservative `profit`-mode floors when not supplied. */
  config: AutoGateConfig = defaultGateConfig("profit"),
): boolean {
  if (risk.rug || risk.bundle || risk.insider) return false;
  if (input.liquidity_usd < config.liqFloorBaseUsd) return false;
  if (output.engine === "A") {
    const a = config.engineA;
    const signalOk =
      output.signal === "BUY_STRONG" ||
      (a.allowModerateAuto && output.signal === "BUY_MODERATE");
    if (!signalOk) return false;
    if (!a.allowStates.includes(output.state)) return false;
    if (output.rank_percentile < a.rankFloor) return false;
    if (input.liquidity_usd < a.liqFloorUsd) return false;
    if ((output.velocity_score ?? 1) < a.velocityFloor) return false;
    return true;
  }
  if (output.signal !== "CONTINUATION_BUY") return false;
  if (output.state !== "acceleration") return false;
  if (output.rank_percentile < config.engineB.rankFloor) return false;
  if (input.price_change_h1 * 2 > config.engineB.maxExtensionPct) return false;
  if (output.trigger_events.length === 0 && output.confidence < 0.45) return false;
  return true;
}

export function isActionableSignalCore(signal: GateSignal): boolean {
  return (
    signal === "BUY_STRONG" ||
    signal === "BUY_MODERATE" ||
    signal === "CONTINUATION_BUY" ||
    signal === "DEX_TREND_ALERT" ||
    signal === "WATCH" ||
    signal === "AVOID" ||
    signal === "EXHAUSTION_WARNING"
  );
}
