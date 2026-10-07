import { CURVE_FEE, BASE_TX_FEE_SOL } from "./fees";

/**
 * Runtime config for the paper engine. Read once from env at worker boot;
 * passed explicitly into executor calls — no hidden globals.
 */

export type PaperRuntimeConfig = {
  startSol: number;
  maxOpenPositions: number;
  maxPositionSol: number;
  dailyLossLimitSol: number;
  enableSlippage: boolean;
  enableFees: boolean;
  enableLatency: boolean;
  /**
   * Per-side trading fee in bps. Sourced from the shared fee model (M03) so the
   * general and research engines cannot drift apart; see packages/trading/src/fees.
   */
  feeBps: number;
  /** Solana base signature fee in SOL per transaction. Charged on failures too. */
  baseTxFeeSol: number;
  /**
   * Priority fee (SOL) charged PER LEG to model the real on-chain cost paper
   * otherwise ignores. On a 0.03–0.05 SOL trade a 0.0005 SOL priority fee is
   * ~1–1.7% per side — material for a thin-edge strategy, so paper must subtract
   * it or its PnL is optimistically biased and the OOS verdict is untrustworthy.
   */
  priorityFeeSol: number;
  /**
   * H09 — new safety limits. These are GATES, not strategy parameters: they can
   * only ever refuse an entry, never change a price, a size or a threshold.
   */
  /** Peak-to-trough equity drawdown past which new entries stop. */
  maxDrawdownPct: number;
  /** Market data older than this blocks a new entry. Unknown age counts as stale. */
  maxDataStalenessMs: number;
  /** Total notional allowed open in any ONE mint. */
  maxPerMintSol: number;
  /** Base slippage floor in bps before liquidity impact. */
  baseSlippageBps: number;
  /**
   * Fallback latency window (ms), used ONLY when no measurement exists.
   * 80-280 was a guess, never a measurement — see measuredLatency.
   */
  latencyMinMs: number;
  latencyMaxMs: number;
  /**
   * M05 — measured end-to-end latency percentiles from `pnpm measure:latency`.
   * When present, fills use this distribution instead of the guess, and the
   * trade records that its latency was measured.
   */
  measuredLatency: { p50: number; p90: number; p99: number } | null;
  markToMarketMs: number;
};

function flag(v: string | undefined, dflt: boolean): boolean {
  if (v == null) return dflt;
  const t = v.trim().toLowerCase();
  if (t === "on" || t === "true" || t === "1") return true;
  if (t === "off" || t === "false" || t === "0") return false;
  return dflt;
}

/**
 * Measured latency percentiles, set from `pnpm measure:latency` output.
 *
 * All three must be present and ordered: a partial measurement is worse than
 * none, because it looks authoritative while describing a distribution nobody
 * measured.
 */
function measuredLatencyFromEnv(env: NodeJS.ProcessEnv): { p50: number; p90: number; p99: number } | null {
  const p50 = Number(env.PAPER_LATENCY_P50_MS);
  const p90 = Number(env.PAPER_LATENCY_P90_MS);
  const p99 = Number(env.PAPER_LATENCY_P99_MS);
  const ok = [p50, p90, p99].every((x) => Number.isFinite(x) && x >= 0);
  if (!ok || !(p50 <= p90 && p90 <= p99)) return null;
  return { p50, p90, p99 };
}

function num(v: string | undefined, dflt: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}

export function paperConfigFromEnv(env: NodeJS.ProcessEnv = process.env): PaperRuntimeConfig {
  return {
    startSol: num(env.PAPER_START_SOL, 10),
    maxOpenPositions: Math.max(1, Math.floor(num(env.PAPER_MAX_OPEN_POSITIONS, 3))),
    maxPositionSol: num(env.PAPER_MAX_POSITION_SOL, 0.25),
    dailyLossLimitSol: num(env.PAPER_DAILY_LOSS_LIMIT_SOL, 1),
    enableSlippage: flag(env.PAPER_ENABLE_SLIPPAGE, true),
    enableFees: flag(env.PAPER_ENABLE_FEES, true),
    enableLatency: flag(env.PAPER_ENABLE_LATENCY, true),
    // 1.25% (0.95% protocol + 0.30% creator), measured. The previous 1.00%
    // predates creator fees and made general paper cheaper than research paper.
    feeBps: CURVE_FEE.totalBps,
    baseTxFeeSol: BASE_TX_FEE_SOL,
    priorityFeeSol: num(env.LIVE_PRIORITY_FEE_SOL, 0.0005),
    maxDrawdownPct: Math.min(1, num(env.PAPER_MAX_DRAWDOWN_PCT, 0.25)),
    maxDataStalenessMs: num(env.PAPER_MAX_DATA_STALENESS_MS, 15_000),
    // Defaults to one position's worth: without an explicit limit, concentrating
    // the whole book in one mint is the failure this gate exists to prevent.
    maxPerMintSol: num(env.PAPER_MAX_PER_MINT_SOL, num(env.PAPER_MAX_POSITION_SOL, 0.25)),
    baseSlippageBps: 30,
    latencyMinMs: 80,
    latencyMaxMs: 280,
    measuredLatency: measuredLatencyFromEnv(env),
    markToMarketMs: Math.max(2000, num(env.PAPER_MARK_TO_MARKET_MS, 10_000)),
  };
}
