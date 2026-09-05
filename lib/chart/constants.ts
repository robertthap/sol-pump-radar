import type { ChartTimeframe } from "@/lib/chart/types";
import { CHART_TIMEFRAMES, DEFAULT_CHART_TF } from "@/lib/chart/timeframes";

export { CHART_TIMEFRAMES, DEFAULT_CHART_TF };

/** pump.fun total supply used for unit price ↔ mcap. */
import { PUMP_SUPPLY } from "@/lib/pump/program";
export { PUMP_SUPPLY };

export const TF_MS: Record<ChartTimeframe, number> = {
  "1s": 1_000,
  "5s": 5_000,
  "15s": 15_000,
  "1m": 60_000,
  "5m": 300_000,
  "15m": 900_000,
  "1h": 3_600_000,
  "4h": 14_400_000,
  "1D": 86_400_000,
};

/** Soft-finalize bucket count per timeframe (GMGN playbook §3). */
export const SOFT_BUCKETS: Record<ChartTimeframe, number> = {
  "1s": 5,
  "5s": 3,
  "15s": 3,
  "1m": 2,
  "5m": 2,
  "15m": 2,
  "1h": 2,
  "4h": 1,
  "1D": 1,
};

/** Default bar density per timeframe (Axiom-style).
 *  Minimum visible body requires ~6px. Short TFs were 3-5px — too narrow to read.
 */
export const TF_BAR_SPACING: Record<ChartTimeframe, number> = {
  "1s": 6,
  "5s": 7,
  "15s": 8,
  "1m": 9,
  "5m": 10,
  "15m": 11,
  "1h": 12,
  "4h": 13,
  "1D": 14,
};

export const COMMIT_BATCH_MS = 75;
/** Chart-aggregator poll cadence. Drives how "live" the chart feels: each tick
 *  pulls new trades for subscribed/recent mints, flushes the commit pipeline, and
 *  pushes COMMIT_BUNDLEs over the WS. Lowered 2000→600ms so live candles track the
 *  market in near-real-time (trade-off: ~3× more indexed fetchTrades queries/tick). */
export const CHART_AGGREGATOR_TICK_MS = 600;
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
