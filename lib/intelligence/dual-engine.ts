import "server-only";
import type { RankInput } from "@/lib/continuation/cross-mint-rank";
import { computeCrossMintRanks } from "@/lib/continuation/cross-mint-rank";
import { fuseEngineIntelligence } from "@/lib/intelligence/engine-fusion";
import type {
  CrossMintRanks,
  EngineIntelligenceOutput,
  IntelligenceEvaluateContext,
  IntelligenceInputSnapshot,
} from "@/lib/intelligence/types";

export { selectEngine } from "@/lib/intelligence/engine-router";

export function buildCrossMintRanks(
  rows: RankInput[],
  priorRanks: Map<string, number> = new Map(),
  deltaMinutes = 0.5,
): Map<string, CrossMintRanks> {
  const table = computeCrossMintRanks(rows, priorRanks, deltaMinutes);
  const out = new Map<string, CrossMintRanks>();
  for (const [mint, r] of table) {
    out.set(mint, {
      rank_percentile: r.rankPercentile,
      velocity_rank: Math.min(1, Math.max(0, 0.5 + r.rankVelocity * 2)),
      liquidity_rank: r.liqRankPercentile,
    });
  }
  return out;
}

/**
 * God function — pure evaluation + fusion. No DB writes.
 */
export function evaluateMintIntelligence(
  input: IntelligenceInputSnapshot,
  ctx: IntelligenceEvaluateContext = {},
): EngineIntelligenceOutput {
  const { output } = fuseEngineIntelligence(input, ctx);
  return output;
}

/** Batch evaluate with shared cross-mint ranks. */
export function evaluateUniverseIntelligence(
  inputs: IntelligenceInputSnapshot[],
  opts?: {
    prior_ranks?: Map<string, number>;
    ops_healthy?: boolean;
    rank_rows?: RankInput[];
  },
): EngineIntelligenceOutput[] {
  const prior = opts?.prior_ranks ?? new Map();
  const rankRows =
    opts?.rank_rows ??
    inputs.map((i) => ({
      mint: i.mint,
      continuationScore:
        i.volume_m5 * 0.4 + i.liquidity_usd * 0.0001 + Math.max(0, i.price_change_m5) * 0.02,
      volAcceleration: i.volume_m30 > 0 ? i.volume_m5 / (i.volume_m30 / 6) : 1,
      weightedLiqUsd: i.liquidity_usd,
      priceChangeH24: i.price_change_h1 * 2,
    }));

  const crossTable = buildCrossMintRanks(rankRows, prior);

  return inputs.map((input) => {
    const cross = crossTable.get(input.mint) ?? {
      rank_percentile: 0.5,
      velocity_rank: 0.5,
      liquidity_rank: 0.5,
    };
    return evaluateMintIntelligence(input, {
      cross_mint: cross,
      prior_rank_percentile: prior.get(input.mint),
      ops_healthy: opts?.ops_healthy ?? true,
      universe_size: inputs.length,
    });
  });
}
