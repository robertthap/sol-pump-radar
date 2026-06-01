/** Client-safe mission control payload types. */

export type ArenaRow = {
  rank: number;
  mint: string;
  symbol: string;
  state: string;
  rank_percentile: number;
  rank_velocity: number;
  continuation_score: number;
  engine_b_action: string | null;
  alert_action: string | null;
  liq_usd: number;
  dex_h24_pct: number | null;
  updated_at: string;
};

export type HeatmapRow = { state: string; n: number };

export type IntelEventRow = {
  mint: string;
  kind: string;
  payload: unknown;
  ts: string | Date;
};

export type CommitPulseRow = {
  mint: string;
  symbol: string;
  ts: string | Date;
  state: string | null;
  rank_percentile: number | null;
  signal: string | null;
  reason: string;
};

export type RankSeries = {
  mint: string;
  symbol: string;
  points: Array<{ t: number; v: number }>;
};

export type ConsolePayload = {
  ts: number;
  workers: string;
  workerHeartbeats: Record<string, number>;
  workerLastTickMs: Record<string, number>;
  stats: { total: number; alert_ready: number; last_updated: string | null };
  intelligence: {
    commits_last_hour: number;
    auto_eligible_last_hour: number;
    engine_a_count: number;
    engine_b_count: number;
  };
  arena: ArenaRow[];
  heatmap: HeatmapRow[];
  events: IntelEventRow[];
  recentCommits: CommitPulseRow[];
  rankSeries: RankSeries[];
};

export type MissReportRow = {
  mint: string;
  symbol: string;
  missType: string;
  stage: string;
  detail: string;
  gapClass?: string;
  suggestedFix?: string;
};
