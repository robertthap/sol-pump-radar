import "server-only";
import type { EngineBResult, NormalizedMintSnapshot } from "@/lib/continuation/types";

export type ContinuationArchetype =
  | "launch_early"
  | "migrated_breakout"
  | "dex_parabolic"
  | "exhaustion"
  | "thin_liq";

export function classifyArchetype(
  snap: NormalizedMintSnapshot,
  result: EngineBResult,
): ContinuationArchetype {
  if (snap.weightedLiqUsd < 8_000) return "thin_liq";
  const h24 = snap.priceChangeH24 ?? 0;
  if (result.state === "parabolic" || h24 > 400) return "dex_parabolic";
  if (result.state === "exhaustion" || result.probabilities.exhaustion > 0.65) {
    return "exhaustion";
  }
  if (snap.poolCount >= 2 && h24 > 30 && h24 < 300) return "migrated_breakout";
  if (result.state === "early_breakout" || result.state === "acceleration") {
    return "launch_early";
  }
  return "migrated_breakout";
}
