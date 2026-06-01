import "server-only";
import type { AutoGateConfig } from "@/lib/intelligence/gate-config";

/** Strict dual-engine output contract (spec). */
export type IntelligenceEngine = "A" | "B";

export type IntelligenceSignal =
  | "BUY_STRONG"
  | "BUY_MODERATE"
  | "CONTINUATION_BUY"
  | "DEX_TREND_ALERT"
  | "EXHAUSTION_WARNING"
  | "WATCH"
  | "AVOID"
  | "NONE";

export type IntelligenceMissType =
  | "NOT_IN_UNIVERSE"
  | "NOT_NORMALIZED"
  | "NO_STATE_TRANSITION"
  | "LOW_RANK"
  | "LATE_PARABOLIC"
  | "LATE_STAGE_PARABOLIC"
  | "EVENT_MISSED"
  | "OPS_FAILURE"
  | "GATE_BLOCKED"
  | "GATE_BLOCKED_EXHAUSTION"
  | "GATE_BLOCKED_LOW_BREAKOUT"
  | "NONE";

export type TriggerEventKind =
  | "volume_spike"
  | "liquidity_jump"
  | "rank_jump"
  | "new_pool_detected"
  | "migration_event"
  | "price_burst";

export type TriggerEvent = {
  kind: TriggerEventKind;
  detail: Record<string, number | string | boolean>;
};

/** Normalized snapshot input (spec). */
export type IntelligenceInputSnapshot = {
  mint: string;
  age_seconds: number;
  liquidity_usd: number;
  volume_m5: number;
  volume_m30: number;
  volume_h1: number;
  price_change_m1: number;
  price_change_m5: number;
  price_change_h1: number;
  buy_sell_ratio: number;
  unique_wallets_5m: number;
  unique_wallets_30m: number;
  holder_growth: number;
  pool_count: number;
  dex_rank: number | null;
  is_new_pool: boolean;
  migration_status: "curve" | "dex" | "graduated";
};

export type CrossMintRanks = {
  rank_percentile: number;
  velocity_rank: number;
  liquidity_rank: number;
};

export type IntelligenceRiskFlags = {
  rug?: boolean;
  bundle?: boolean;
  insider?: boolean;
  rapid_sell_pressure?: boolean;
};

export type IntelligenceEvaluateContext = {
  engine?: IntelligenceEngine;
  in_universe?: boolean;
  normalized?: boolean;
  ops_healthy?: boolean;
  cross_mint?: CrossMintRanks;
  prior_volume_m5?: number;
  prior_liquidity_usd?: number;
  prior_rank_percentile?: number;
  trigger_events?: TriggerEvent[];
  risk_flags?: IntelligenceRiskFlags;
  universe_size?: number;
  prior_state?: string;
  /** Mode + learner-aware auto-trade gate config; defaults applied if absent. */
  gateConfig?: AutoGateConfig;
};

/** Required output for every mint evaluation. */
export type EngineIntelligenceOutput = {
  mint: string;
  engine: IntelligenceEngine;
  state: string;
  rank_percentile: number;
  signal: IntelligenceSignal;
  auto_trade_allowed: boolean;
  confidence: number;
  reason: string;
  trigger_events: TriggerEvent[];
  miss_type: IntelligenceMissType | null;
  /** Launch-velocity score [0..1] (Engine A); enforced by the auto-gate. */
  velocity_score?: number;
};
