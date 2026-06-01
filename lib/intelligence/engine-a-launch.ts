import "server-only";
import type {
  CrossMintRanks,
  EngineIntelligenceOutput,
  IntelligenceEvaluateContext,
  IntelligenceInputSnapshot,
  IntelligenceRiskFlags,
  IntelligenceSignal,
} from "@/lib/intelligence/types";
import { detectTriggerEvents, eventImpulseFromTriggers } from "@/lib/intelligence/event-triggers";
import { defaultGateConfig, type AutoGateConfig } from "@/lib/intelligence/gate-config";
import {
  scoreLaunchVelocity,
  DEFAULT_VELOCITY_CONFIG,
} from "@/lib/intelligence/launch-velocity";

export type LaunchState = "cold" | "launching" | "early_breakout" | "acceleration";

function clamp01(n: number) {
  return Math.max(0, Math.min(1, n));
}

export function computeLaunchState(input: IntelligenceInputSnapshot): {
  state: LaunchState;
  confidence: number;
} {
  const scores: Record<LaunchState, number> = {
    cold: 0.2,
    launching: 0.15,
    early_breakout: 0.1,
    acceleration: 0.08,
  };

  if (input.liquidity_usd < 4_000) {
    scores.cold = 0.8;
  } else {
    scores.cold = 0.05;
  }

  if (input.is_new_pool || input.age_seconds < 300) {
    scores.launching += 0.45;
  }
  if (input.volume_m5 > input.volume_m30 * 0.25 && input.price_change_m5 > 5) {
    scores.early_breakout += 0.4;
  }
  if (
    input.price_change_m5 > 12 &&
    input.price_change_h1 > 8 &&
    input.buy_sell_ratio > 0.55
  ) {
    scores.acceleration += 0.5;
  }
  if (input.unique_wallets_5m > 12 && input.holder_growth > 0.1) {
    scores.early_breakout += 0.25;
    scores.acceleration += 0.2;
  }

  const sum = Object.values(scores).reduce((a, b) => a + b, 0) || 1;
  const entries = (Object.keys(scores) as LaunchState[]).map((state) => ({
    state,
    confidence: clamp01(scores[state] / sum),
  }));
  entries.sort((a, b) => b.confidence - a.confidence);
  return { state: entries[0]!.state, confidence: entries[0]!.confidence };
}

function resolveEngineASignal(
  state: LaunchState,
  rank: number,
  input: IntelligenceInputSnapshot,
  risk: IntelligenceRiskFlags,
  cfg: AutoGateConfig,
  velocityScore: number,
): { signal: IntelligenceSignal; reason: string } {
  if (input.liquidity_usd < cfg.liqFloorBaseUsd || risk.rug || risk.rapid_sell_pressure) {
    return { signal: "AVOID", reason: "low_liquidity_or_risk" };
  }
  if (risk.bundle || risk.insider) {
    return { signal: "AVOID", reason: "bundle_or_insider_flag" };
  }

  const vol2x =
    input.volume_m30 > 0 && input.volume_m5 >= (input.volume_m30 / 6) * 2;
  const velocityOk = velocityScore >= cfg.engineA.velocityFloor;

  // Mode-aware BUY_STRONG: launch/hybrid modes allow fresh, low-liquidity
  // breakouts but require real launch velocity (sustained-liquidity signal);
  // profit mode keeps the conservative mature-token floors (velocityFloor 0).
  if (
    cfg.engineA.allowStates.includes(state) &&
    input.liquidity_usd >= cfg.engineA.liqFloorUsd &&
    vol2x &&
    velocityOk &&
    rank >= cfg.engineA.rankFloor
  ) {
    return {
      signal: "BUY_STRONG",
      reason: `breakout_liq${Math.round(cfg.engineA.liqFloorUsd)}_rank${cfg.engineA.rankFloor.toFixed(2)}_vel${velocityScore.toFixed(2)}_vol2x`,
    };
  }

  if (
    (state === "early_breakout" || state === "launching") &&
    rank >= 0.6 &&
    rank < 0.8
  ) {
    return { signal: "BUY_MODERATE", reason: "early_signal_rank60_80" };
  }

  if (state === "launching" || state === "cold") {
    return { signal: "WATCH", reason: "pre_breakout_monitoring" };
  }

  return { signal: "WATCH", reason: "insufficient_confirmation" };
}

function engineAAutoAllowed(
  signal: IntelligenceSignal,
  state: LaunchState,
  rank: number,
  input: IntelligenceInputSnapshot,
  risk: IntelligenceRiskFlags,
  events: EngineIntelligenceOutput["trigger_events"],
  cfg: AutoGateConfig,
  velocityScore: number,
): boolean {
  const a = cfg.engineA;
  const signalOk =
    signal === "BUY_STRONG" || (a.allowModerateAuto && signal === "BUY_MODERATE");
  if (!signalOk) return false;
  if (!a.allowStates.includes(state)) return false;
  if (rank < a.rankFloor) return false;
  if (input.liquidity_usd < a.liqFloorUsd) return false;
  if (velocityScore < a.velocityFloor) return false;
  if (risk.rug || risk.bundle || risk.insider) return false;
  if (events.some((e) => e.kind === "migration_event") && input.migration_status === "curve") {
    return false;
  }
  return true;
}

function classifyEngineAMiss(
  signal: IntelligenceSignal,
  ctx: IntelligenceEvaluateContext,
  state: LaunchState,
  rank: number,
): EngineIntelligenceOutput["miss_type"] {
  if (signal !== "NONE" && signal !== "WATCH") return null;
  if (ctx.in_universe === false) return "NOT_IN_UNIVERSE";
  if (ctx.normalized === false) return "NOT_NORMALIZED";
  if (!ctx.ops_healthy) return "OPS_FAILURE";
  if (state === "cold") return "NO_STATE_TRANSITION";
  if (rank < 0.5) return "LOW_RANK";
  if ((ctx.trigger_events?.length ?? 0) === 0) return "EVENT_MISSED";
  return "NO_STATE_TRANSITION";
}

export function evaluateEngineA(
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
      prior_price_change_m5: undefined,
    });

  const { state, confidence } = computeLaunchState(input);
  const risk = ctx.risk_flags ?? {};
  const cfg = ctx.gateConfig ?? defaultGateConfig("profit");

  // Launch-velocity score (sustained-liquidity predictor) from the snapshot.
  // Liquidity is in USD here, so we use a USD-scaled minVSol (the launch floor).
  const velocity = scoreLaunchVelocity(
    {
      vSol: input.liquidity_usd,
      priorVSol: ctx.prior_liquidity_usd,
      uniqueBuyers: input.unique_wallets_5m,
      buySellRatio: input.buy_sell_ratio,
      priceImpulsePct: input.price_change_m5,
    },
    { ...DEFAULT_VELOCITY_CONFIG, minVSol: Math.max(1, cfg.engineA.liqFloorUsd) },
  );

  const { signal, reason: signalReason } = resolveEngineASignal(
    state,
    cross.rank_percentile,
    input,
    risk,
    cfg,
    velocity.score,
  );

  const eventNote =
    trigger_events.length > 0
      ? `|events=${trigger_events.map((e) => e.kind).join(",")}`
      : "";
  const impulse = eventImpulseFromTriggers(trigger_events);

  const auto_trade_allowed = engineAAutoAllowed(
    signal,
    state,
    cross.rank_percentile,
    input,
    risk,
    trigger_events,
    cfg,
    velocity.score,
  );

  const miss_type = classifyEngineAMiss(signal, ctx, state, cross.rank_percentile);

  return {
    mint: input.mint,
    engine: "A",
    state,
    rank_percentile: cross.rank_percentile,
    signal,
    auto_trade_allowed,
    velocity_score: velocity.score,
    confidence: clamp01(confidence + impulse * 0.1),
    reason: [
      "engine=A",
      `state=${state}`,
      `rank=${cross.rank_percentile.toFixed(2)}`,
      `vel_rank=${cross.velocity_rank.toFixed(2)}`,
      `liq_rank=${cross.liquidity_rank.toFixed(2)}`,
      `velocity=${velocity.score.toFixed(2)}`,
      `signal=${signal}`,
      signalReason,
      eventNote,
    ]
      .join("|")
      .slice(0, 500),
    trigger_events,
    miss_type: signal === "WATCH" || signal === "NONE" ? miss_type : null,
  };
}
