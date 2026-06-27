/**
 * Genesis-sniper pure decision function. Built 2026-06-15 after analysing 115
 * elite wallets in our DB (6,133 buys): the proven winning pattern is to buy
 * at vSol 18–60 within ~10s of launch and hold ~22s. This module is the
 * fire/skip judgment given a fresh-mint signal — no IO, no time, all inputs.
 */
import { scoreLaunchVelocity, type LaunchVelocityInput } from "./launch-velocity";

export type GenesisSignal = {
  mint: string;
  /** Age of the mint at evaluation time, in seconds (from create event). */
  ageSec: number;
  /** Current bonding-curve virtual SOL reserves. */
  currentVSol: number;
  /** Curve vSol at the earliest event we have for this mint. */
  initialVSol: number | null;
  /** Buy events on this mint in the last 30s. */
  buys30s: number;
  /** Sell events on this mint in the last 30s. */
  sells30s: number;
  /** Distinct buyer wallets in the last 30s (the organic-flow signal). */
  uniqueBuyers30s: number;
  /** Sum of bought SOL in the last 30s — the actual capital flowing in. */
  buyVolSol30s: number;
  /** Sum of sold SOL in the last 30s. */
  sellVolSol30s: number;
};

export type GenesisDecision = {
  fire: boolean;
  reason: string;
  confidence: number;          // [0,1] — velocity score, regardless of fire
  vSolBucket: string;
};

export type GenesisConfig = {
  /** Minimum age — too-fresh mints (< this seconds since create) are skipped to avoid frontrunning before we can score. */
  minAgeSec: number;
  /** Maximum age — past this, we're no longer "genesis", elite wallets have moved on. */
  maxAgeSec: number;
  /** Minimum currentVSol — too low = too thin / rug-prone. */
  minVSol: number;
  /** Maximum currentVSol — above this, we're past the genesis stage where elite wallets play. */
  maxVSol: number;
  /** Minimum buys in the last 30s. */
  minBuys30s: number;
  /** Minimum distinct buyer wallets in the last 30s — organic-flow gate. */
  minUniqueBuyers30s: number;
  /** Minimum buy/(buy+sell) volume ratio — sellers must not dominate. */
  minBuySellRatio: number;
  /** Minimum velocity score [0,1] from scoreLaunchVelocity. */
  minVelocityScore: number;
};

/**
 * Defaults derived from the 115-wallet elite analysis (2026-06-15):
 *   median entry vSol = 29.2; p25–p75 = 18.8–42.0; median age = 10s; median hold = 22s.
 * We sit in their interquartile zone (vSol 18–42), demand minimal organic flow
 * (≥3 distinct buyers, ≥4 buys in 30s, ≥0.55 buy/(buy+sell)), and require the
 * velocity score to exceed a moderate threshold so we don't fire on noise.
 */
export const DEFAULT_GENESIS_CONFIG: GenesisConfig = {
  minAgeSec: 5,
  maxAgeSec: 60,
  minVSol: 18,
  maxVSol: 60,
  minBuys30s: 4,
  minUniqueBuyers30s: 3,
  minBuySellRatio: 0.55,
  minVelocityScore: 0.35,
};

function vSolBucket(v: number): string {
  if (v < 31) return "genesis";
  if (v < 40) return "very_early";
  if (v < 60) return "early";
  if (v < 85) return "mid";
  if (v < 113) return "late";
  return "post_grad";
}

export function evaluateGenesisSnipe(
  s: GenesisSignal,
  cfg: GenesisConfig = DEFAULT_GENESIS_CONFIG,
): GenesisDecision {
  const bucket = vSolBucket(s.currentVSol);
  // Stage-1 gates — cheap hard cuts before scoring.
  if (s.ageSec < cfg.minAgeSec)
    return { fire: false, reason: `too_fresh ${s.ageSec.toFixed(0)}s<${cfg.minAgeSec}`, confidence: 0, vSolBucket: bucket };
  if (s.ageSec > cfg.maxAgeSec)
    return { fire: false, reason: `too_old ${s.ageSec.toFixed(0)}s>${cfg.maxAgeSec}`, confidence: 0, vSolBucket: bucket };
  if (s.currentVSol < cfg.minVSol)
    return { fire: false, reason: `vSol_low ${s.currentVSol.toFixed(1)}<${cfg.minVSol}`, confidence: 0, vSolBucket: bucket };
  if (s.currentVSol > cfg.maxVSol)
    return { fire: false, reason: `vSol_high ${s.currentVSol.toFixed(1)}>${cfg.maxVSol}`, confidence: 0, vSolBucket: bucket };
  if (s.buys30s < cfg.minBuys30s)
    return { fire: false, reason: `buys_low ${s.buys30s}<${cfg.minBuys30s}`, confidence: 0, vSolBucket: bucket };
  if (s.uniqueBuyers30s < cfg.minUniqueBuyers30s)
    return { fire: false, reason: `uniq_low ${s.uniqueBuyers30s}<${cfg.minUniqueBuyers30s}`, confidence: 0, vSolBucket: bucket };

  // Buy/(buy+sell) volume ratio — sellers must not dominate.
  const totVol = s.buyVolSol30s + s.sellVolSol30s;
  const bsr = totVol > 0 ? s.buyVolSol30s / totVol : 1;
  if (bsr < cfg.minBuySellRatio)
    return { fire: false, reason: `bsr_low ${bsr.toFixed(2)}<${cfg.minBuySellRatio}`, confidence: 0, vSolBucket: bucket };

  // Stage 2 — composite velocity score (existing pure function).
  const vInput: LaunchVelocityInput = {
    vSol: s.currentVSol,
    priorVSol: s.initialVSol ?? undefined,
    buys: s.buys30s,
    uniqueBuyers: s.uniqueBuyers30s,
    buySellRatio: bsr,
  };
  const v = scoreLaunchVelocity(vInput);
  if (v.vetoed) {
    return { fire: false, reason: `velocity_veto:${v.vetoReason}`, confidence: v.score, vSolBucket: bucket };
  }
  if (v.score < cfg.minVelocityScore) {
    return { fire: false, reason: `velocity ${v.score.toFixed(2)}<${cfg.minVelocityScore}`, confidence: v.score, vSolBucket: bucket };
  }

  return {
    fire: true,
    reason: `genesis_fire vSol=${s.currentVSol.toFixed(1)} age=${s.ageSec.toFixed(0)}s buys=${s.buys30s} uniq=${s.uniqueBuyers30s} bsr=${bsr.toFixed(2)} vel=${v.score.toFixed(2)}`,
    confidence: v.score,
    vSolBucket: bucket,
  };
}
