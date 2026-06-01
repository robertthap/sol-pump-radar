import "server-only";
import type { EngineBResult } from "@/lib/continuation/types";

export type RankInput = {
  mint: string;
  continuationScore: number;
  volAcceleration: number;
  weightedLiqUsd: number;
  priceChangeH24: number | null;
};

export type RankOutput = {
  rankPercentile: number;
  volRankPercentile: number;
  liqRankPercentile: number;
  rankVelocity: number;
};

function percentileRank(values: number[], value: number): number {
  if (!values.length) return 0.5;
  const below = values.filter((v) => v < value).length;
  return below / values.length;
}

export function computeCrossMintRanks(
  rows: RankInput[],
  priorRanks: Map<string, number>,
  deltaMinutes = 0.5,
): Map<string, RankOutput> {
  const scores = rows.map((r) => r.continuationScore);
  const vols = rows.map((r) => r.volAcceleration);
  const liqs = rows.map((r) => r.weightedLiqUsd);

  const out = new Map<string, RankOutput>();
  for (const r of rows) {
    const rankPercentile = percentileRank(scores, r.continuationScore);
    const prior = priorRanks.get(r.mint);
    const rankVelocity =
      prior != null ? (rankPercentile - prior) / Math.max(deltaMinutes, 0.5) : 0;
    out.set(r.mint, {
      rankPercentile,
      volRankPercentile: percentileRank(vols, r.volAcceleration),
      liqRankPercentile: percentileRank(liqs, r.weightedLiqUsd),
      rankVelocity,
    });
  }
  return out;
}

export function rankInputFromResult(
  mint: string,
  snap: { volAcceleration: number; weightedLiqUsd: number; priceChangeH24: number | null },
  result: Pick<EngineBResult, "continuationScore">,
): RankInput {
  return {
    mint,
    continuationScore: result.continuationScore,
    volAcceleration: snap.volAcceleration,
    weightedLiqUsd: snap.weightedLiqUsd,
    priceChangeH24: snap.priceChangeH24,
  };
}
