import "server-only";
import { engineB } from "@/lib/continuation/engine-b";
import { getPriorState } from "@/lib/continuation/state-registry";
import type { EngineBAction, EngineBResult, MomentumState } from "@/lib/continuation/types";
import { intelligenceInputToNormalized } from "@/lib/intelligence/normalized-adapter";
import {
  detectTriggerEvents,
  eventImpulseFromTriggers,
} from "@/lib/intelligence/event-triggers";
import type {
  CrossMintRanks,
  EngineIntelligenceOutput,
  IntelligenceEvaluateContext,
  IntelligenceInputSnapshot,
  IntelligenceMissType,
  IntelligenceSignal,
} from "@/lib/intelligence/types";

function mapEngineBActionToSignal(action: EngineBAction): IntelligenceSignal {
  switch (action) {
    case "ALERT":
      return "DEX_TREND_ALERT";
    case "CONTINUATION_BUY":
      return "CONTINUATION_BUY";
    case "EXHAUSTION":
      return "EXHAUSTION_WARNING";
    case "WATCH":
      return "WATCH";
    default:
      return "NONE";
  }
}

function engineBAutoAllowed(
  result: EngineBResult,
  input: IntelligenceInputSnapshot,
  signal: IntelligenceSignal,
  events: EngineIntelligenceOutput["trigger_events"],
): boolean {
  if (signal !== "CONTINUATION_BUY") return false;
  if (result.state !== "acceleration") return false;
  if (result.rankPercentile < 0.85) return false;
  const h24 = input.price_change_h1 * 2;
  if (h24 > 300) return false;
  if (input.liquidity_usd < 8_000) return false;
  if (events.length === 0 && result.components.eventImpulse < 0.1) return false;
  return true;
}

function classifyEngineBMiss(
  result: EngineBResult,
  signal: IntelligenceSignal,
  ctx: IntelligenceEvaluateContext,
): IntelligenceMissType | null {
  if (signal !== "NONE" && signal !== "WATCH") return null;
  if (ctx.in_universe === false) return "NOT_IN_UNIVERSE";
  if (ctx.normalized === false) return "NOT_NORMALIZED";
  if (!ctx.ops_healthy) return "OPS_FAILURE";

  if (result.gateFlags.blockedByExhaustion) return "GATE_BLOCKED_EXHAUSTION";
  if (result.gateFlags.blockedByLowBreakout) return "GATE_BLOCKED_LOW_BREAKOUT";
  if (result.gateFlags.blockedByExhaustion || result.gateFlags.cappedByParabolic) {
    return "GATE_BLOCKED";
  }

  if (result.state === "parabolic" || result.state === "exhaustion") {
    return "LATE_PARABOLIC";
  }

  if (result.rankPercentile < 0.5) return "LOW_RANK";

  if ((ctx.trigger_events?.length ?? 0) === 0 && result.components.eventImpulse < 0.15) {
    return "EVENT_MISSED";
  }

  if (result.state === "cold") return "NO_STATE_TRANSITION";

  return "NO_STATE_TRANSITION";
}

export function evaluateEngineB(
  input: IntelligenceInputSnapshot,
  ctx: IntelligenceEvaluateContext = {},
): EngineIntelligenceOutput {
  const cross = ctx.cross_mint ?? {
    rank_percentile: 0.5,
    velocity_rank: 0.5,
    liquidity_rank: 0.5,
  };

  const trigger_events =
    ctx.trigger_events ??
    detectTriggerEvents({
      volume_m5: input.volume_m5,
      prior_volume_m5: ctx.prior_volume_m5,
      liquidity_usd: input.liquidity_usd,
      prior_liquidity_usd: ctx.prior_liquidity_usd,
      rank_percentile: cross.rank_percentile,
      prior_rank_percentile: ctx.prior_rank_percentile,
      is_new_pool: input.is_new_pool,
      migration_status: input.migration_status,
      price_change_m5: input.price_change_m5,
    });

  const normalized = intelligenceInputToNormalized(input);
  const eventImpulse = eventImpulseFromTriggers(trigger_events);

  const { result } = engineB(input.mint, normalized, {
    rankPercentile: cross.rank_percentile,
    rankVelocity: (cross.rank_percentile - (ctx.prior_rank_percentile ?? cross.rank_percentile)) / 0.5,
    eventImpulse,
    leadingScore: Math.min(1, input.holder_growth + input.buy_sell_ratio * 0.2),
    universeSize: ctx.universe_size ?? 1,
    priorState: (ctx.prior_state as MomentumState | undefined) ?? getPriorState(input.mint),
    persistTrace: false,
  });

  const signal = mapEngineBActionToSignal(result.action);
  const auto_trade_allowed = engineBAutoAllowed(result, input, signal, trigger_events);
  const miss_type = classifyEngineBMiss(result, signal, ctx);

  return {
    mint: input.mint,
    engine: "B",
    state: result.state,
    rank_percentile: result.rankPercentile,
    signal,
    auto_trade_allowed,
    confidence: result.stateConfidence,
    reason: [
      result.reason,
      `vel_rank=${cross.velocity_rank.toFixed(2)}`,
      `liq_rank=${cross.liquidity_rank.toFixed(2)}`,
      auto_trade_allowed ? "auto=eligible" : "auto=blocked",
      trigger_events.length ? `events=${trigger_events.map((e) => e.kind).join(",")}` : "",
    ]
      .join("|")
      .slice(0, 500),
    trigger_events,
    miss_type,
  };
}

/** Format existing EngineBResult into strict contract (workers / traces). */
export function formatEngineBIntelligenceOutput(
  result: EngineBResult,
  opts: {
    cross_mint?: CrossMintRanks;
    trigger_events?: EngineIntelligenceOutput["trigger_events"];
    input?: IntelligenceInputSnapshot;
    ctx?: IntelligenceEvaluateContext;
  } = {},
): EngineIntelligenceOutput {
  const signal = mapEngineBActionToSignal(result.action);
  const input =
    opts.input ??
    ({
      mint: result.mint,
      age_seconds: 3600,
      liquidity_usd: result.components.liquidityQuality * 20_000,
      volume_m5: 0,
      volume_m30: 0,
      volume_h1: 0,
      price_change_m1: 0,
      price_change_m5: result.components.rankMomentum * 20,
      price_change_h1: 0,
      buy_sell_ratio: 0.5,
      unique_wallets_5m: 0,
      unique_wallets_30m: 0,
      holder_growth: 0,
      pool_count: 1,
      dex_rank: null,
      is_new_pool: false,
      migration_status: "dex",
    } satisfies IntelligenceInputSnapshot);

  const trigger_events = opts.trigger_events ?? [];
  const ctx = opts.ctx ?? { ops_healthy: true, in_universe: true, normalized: true };
  const auto_trade_allowed = engineBAutoAllowed(result, input, signal, trigger_events);

  return {
    mint: result.mint,
    engine: "B",
    state: result.state,
    rank_percentile: result.rankPercentile,
    signal,
    auto_trade_allowed,
    confidence: result.stateConfidence,
    reason: result.reason,
    trigger_events,
    miss_type: classifyEngineBMiss(result, signal, ctx),
  };
}
