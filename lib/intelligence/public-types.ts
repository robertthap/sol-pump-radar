/** Client-safe intelligence types (no server-only imports). */

export type IntelligenceEnginePublic = "A" | "B";

export type IntelligenceSignalPublic =
  | "BUY_STRONG"
  | "BUY_MODERATE"
  | "CONTINUATION_BUY"
  | "DEX_TREND_ALERT"
  | "EXHAUSTION_WARNING"
  | "WATCH"
  | "AVOID"
  | "NONE";

export type IntelligenceCommitRow = {
  mint: string;
  ts: string;
  engine: IntelligenceEnginePublic;
  state: string;
  signal: IntelligenceSignalPublic;
  rank_percentile: number;
  auto_trade_allowed: boolean;
  confidence: number;
  reason: string;
  miss_type: string | null;
  legacy_action: string;
  executed_hint: string | null;
  trigger_events: string[];
  fusion_summary: string | null;
};

export type IntelligenceFeedStats = {
  commits_last_hour: number;
  auto_eligible_last_hour: number;
  engine_a_count: number;
  engine_b_count: number;
};

/** Live preview from /api/intelligence/mint?preview=1 (not persisted). */
export type IntelligencePreviewOutput = {
  mint: string;
  engine: IntelligenceEnginePublic;
  state: string;
  rank_percentile: number;
  signal: IntelligenceSignalPublic;
  auto_trade_allowed: boolean;
  confidence: number;
  reason: string;
};
