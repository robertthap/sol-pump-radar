import "server-only";

import type { DexMarketSnapshot } from "@/lib/dex/market-snapshot";

import { normalizeDexSnapshot } from "@/lib/dex/normalizer";

import { engineB } from "@/lib/continuation/engine-b";



export type ContinuationScoreResult = {

  continuationScore: number;

  exhaustionRisk: number;

  suggestedAction: "DEX_TREND_ALERT" | "WATCH" | "CONTINUATION_BUY" | "EXHAUSTION_WARNING" | "SKIP";

  reasons: string[];

  vetoes: string[];

  confidence: number;

};



function mapAction(

  action: string,

): ContinuationScoreResult["suggestedAction"] {

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

      return "SKIP";

  }

}



/**

 * Engine B wrapper — delegates to canonical engineB().

 */

export function scoreContinuation(

  snap: DexMarketSnapshot,

  opts?: { minLiqUsd?: number; rankPercentile?: number; rankVelocity?: number },

): ContinuationScoreResult {

  const normalized = normalizeDexSnapshot(snap);

  if (normalized.weightedLiqUsd < (opts?.minLiqUsd ?? 8_000)) {

    return {

      continuationScore: 0,

      exhaustionRisk: 1,

      suggestedAction: "SKIP",

      reasons: ["thin liquidity"],

      vetoes: [`liq_usd=${normalized.weightedLiqUsd.toFixed(0)}`],

      confidence: 0,

    };

  }



  const { result } = engineB(snap.mint, normalized, {

    rankPercentile: opts?.rankPercentile ?? 0.5,

    rankVelocity: opts?.rankVelocity ?? 0,

    eventImpulse: 0,

    leadingScore: 0,

    universeSize: 1,

    persistTrace: false,

  });



  const vetoes: string[] = [];

  if (result.gateFlags.blockedByExhaustion) vetoes.push("exhaustion_gate");

  if (result.gateFlags.blockedByLowBreakout) vetoes.push("low_breakout");

  if (result.gateFlags.cappedByParabolic) vetoes.push("parabolic_cap");



  return {

    continuationScore: result.continuationScore,

    exhaustionRisk: result.probabilities.exhaustion,

    suggestedAction: mapAction(result.action),

    reasons: [result.reason],

    vetoes,

    confidence: result.stateConfidence,

  };

}


