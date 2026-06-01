import "server-only";
import { fuseEngineIntelligence } from "@/lib/intelligence/engine-fusion";
import type { IntelligenceInputSnapshot } from "@/lib/intelligence/types";
import { detectTriggerEvents } from "@/lib/intelligence/event-triggers";

export type ReplayStep = {
  ts: number;
  input: IntelligenceInputSnapshot;
  prior?: IntelligenceInputSnapshot;
  prior_rank?: number;
};

export type ReplayStepResult = {
  ts: number;
  signal: string;
  state: string;
  rank_percentile: number;
  auto_trade_allowed: boolean;
  first_actionable: boolean;
};

/** Step through snapshots to find first actionable signal (not post-mortem end state). */
export function replayMintTransitions(steps: ReplayStep[]): {
  steps: ReplayStepResult[];
  firstEntryTs: number | null;
  firstSignal: string | null;
} {
  const results: ReplayStepResult[] = [];
  let firstEntryTs: number | null = null;
  let firstSignal: string | null = null;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    const prior = i > 0 ? steps[i - 1]!.input : step.prior;
    const priorRank = i > 0 ? results[i - 1]!.rank_percentile : step.prior_rank ?? 0.5;

    const trigger_events = detectTriggerEvents({
      volume_m5: step.input.volume_m5,
      prior_volume_m5: prior?.volume_m5,
      liquidity_usd: step.input.liquidity_usd,
      prior_liquidity_usd: prior?.liquidity_usd,
      rank_percentile: priorRank,
      prior_rank_percentile: step.prior_rank,
      is_new_pool: step.input.is_new_pool,
      migration_status: step.input.migration_status,
      prior_migration_status: prior?.migration_status,
      price_change_m5: step.input.price_change_m5,
      prior_price_change_m5: prior?.price_change_m5,
    });

    const { output } = fuseEngineIntelligence(step.input, {
      cross_mint: {
        rank_percentile: priorRank,
        velocity_rank: 0.5,
        liquidity_rank: 0.5,
      },
      trigger_events,
      prior_rank_percentile: step.prior_rank,
      universe_size: steps.length,
    });

    const actionable =
      output.signal === "BUY_STRONG" ||
      output.signal === "CONTINUATION_BUY" ||
      output.signal === "DEX_TREND_ALERT" ||
      output.signal === "BUY_MODERATE";

    if (actionable && firstEntryTs == null) {
      firstEntryTs = step.ts;
      firstSignal = output.signal;
    }

    results.push({
      ts: step.ts,
      signal: output.signal,
      state: output.state,
      rank_percentile: output.rank_percentile,
      auto_trade_allowed: output.auto_trade_allowed,
      first_actionable: actionable && firstEntryTs === step.ts,
    });
  }

  return { steps: results, firstEntryTs, firstSignal };
}
