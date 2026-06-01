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
  /** Per-side fee in bps (e.g. 100 = 1.0%). pump.fun graduates take ~1% per side. */
  feeBps: number;
  /** Base slippage floor in bps before liquidity impact. */
  baseSlippageBps: number;
  /** Simulated execution latency window (ms) when latency is enabled. */
  latencyMinMs: number;
  latencyMaxMs: number;
  markToMarketMs: number;
};

function flag(v: string | undefined, dflt: boolean): boolean {
  if (v == null) return dflt;
  const t = v.trim().toLowerCase();
  if (t === "on" || t === "true" || t === "1") return true;
  if (t === "off" || t === "false" || t === "0") return false;
  return dflt;
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
    feeBps: 100,
    baseSlippageBps: 30,
    latencyMinMs: 80,
    latencyMaxMs: 280,
    markToMarketMs: Math.max(2000, num(env.PAPER_MARK_TO_MARKET_MS, 10_000)),
  };
}
