import "server-only";
import type { CommitInputBundle } from "@/lib/intelligence/commit-input";
import type { CrossMintRanks } from "@/lib/intelligence/types";
import { getHotMintScores, getTopLaunchHotMints } from "@/lib/intelligence/hot-mints";
import { intelEnv } from "@/lib/env";
import type { IntelligenceSignal } from "@/lib/intelligence/types";
import { planMintsToEvaluateCore, type EvalPlan } from "@/lib/intelligence/eval-scheduler-plan";

export type { EvalPlan };

type LastEval = {
  at: number;
  signal: IntelligenceSignal;
  state: string;
  rankBucket: number;
};

const lastEval = new Map<string, LastEval>();

function rankBucket(p: number): number {
  return Math.round(p * 20) / 20;
}

export function noteEvalOutcome(
  mint: string,
  output: { signal: IntelligenceSignal; state: string; rank_percentile: number },
): void {
  lastEval.set(mint, {
    at: Date.now(),
    signal: output.signal,
    state: output.state,
    rankBucket: rankBucket(output.rank_percentile),
  });
}

export function hasMaterialChange(
  mint: string,
  output: { signal: IntelligenceSignal; state: string; rank_percentile: number },
): boolean {
  const prev = lastEval.get(mint);
  if (!prev) return true;
  if (prev.signal !== output.signal) return true;
  if (prev.state !== output.state) return true;
  if (prev.rankBucket !== rankBucket(output.rank_percentile)) return true;
  return false;
}

export function planMintsToEvaluate(
  bundle: CommitInputBundle,
  crossTable: Map<string, CrossMintRanks>,
  triggerByMint: Map<string, { length: number }>,
  opts?: {
    topRank?: number;
    skipUnchangedMs?: number;
    maxEvaluate?: number;
  },
): EvalPlan {
  const cfg = intelEnv();
  const now = Date.now();
  const crossRank = new Map<string, number>();
  for (const [mint, c] of crossTable) crossRank.set(mint, c.rank_percentile);

  const hotScores = getHotMintScores(now).filter(
    (h) => !(h.state === "HOT_LAUNCH" && h.source === "INGESTOR"),
  );

  const lastEvalAt = new Map<string, number>();
  for (const [mint, e] of lastEval) lastEvalAt.set(mint, e.at);

  return planMintsToEvaluateCore(
    bundle.mints,
    new Set(bundle.rows.keys()),
    crossRank,
    triggerByMint,
    {
      topRank: opts?.topRank ?? cfg.topRankAlways,
      skipUnchangedMs: opts?.skipUnchangedMs ?? cfg.skipUnchangedMs,
      maxEvaluate: opts?.maxEvaluate ?? cfg.maxEvaluatePerTick,
      maxLaunchHot: cfg.maxLaunchHotPerTick,
      launchHotMints: getTopLaunchHotMints(cfg.maxLaunchHotPerTick, now),
      continuationHotMints: hotScores.map((h) => h.mint),
      lastEvalAt,
    },
    now,
  );
}
