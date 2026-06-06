import type { ChartTimeframe } from "@/lib/chart/types";

/** pump.fun total supply used for unit price ↔ mcap. */
export const PUMP_SUPPLY = 1e9;

export const TF_MS: Record<ChartTimeframe, number> = {
  "1s": 1000,
  "5s": 5000,
  "1m": 60_000,
};

/** Soft-finalize bucket count per timeframe (GMGN playbook §3). */
export const SOFT_BUCKETS: Record<ChartTimeframe, number> = {
  "1s": 5,
  "5s": 3,
  "1m": 2,
};

export const COMMIT_BATCH_MS = 75;
export const RECONCILE_INTERVAL_MS = 30_000;
export const DEX_QUOTE_POLL_MS = 3_000;
export const CHECKPOINT_TRADE_INTERVAL = 500;
export const CHECKPOINT_TIME_MS = 30_000;
export const MAX_WARM_MINTS = 50;
export const MAX_LIVE_BUFFER = 50;
export const SCROLL_PREFETCH_BARS = 20;
export const SCROLL_DEBOUNCE_MS = 150;
export const CANDLE_PAGE_SIZE = 500;
export const CHECKPOINT_CANDLE_COUNT = 120;
export const TAIL_REPLAY_MAX_TRADES = 300;
export const TAIL_REPLAY_MAX_MS = 5 * 60_000;
export const RECONCILE_CPU_BUDGET_MS = 200;
export const DEX_QUOTE_LOOKBACK_MS = 5_000;
export const DEFAULT_CHART_TF: ChartTimeframe = "1m";
