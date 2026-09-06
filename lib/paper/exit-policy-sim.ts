/**
 * Replay a recorded position path through a candidate exit policy (pure, testable).
 *
 * The simulator calls the PRODUCTION decision function (decidePaperExit) rather
 * than reimplementing it, so a policy evaluated here cannot drift from what the
 * worker would actually do. The only rule expressed outside it is `deadFlow`,
 * which keys off a signal decidePaperExit has no access to (seconds since the
 * coin's last trade) and is therefore checked before the standard ladder.
 *
 * Resolution is the mark cadence (~30s), so an exit age is accurate to about
 * one mark. That is fine for choosing between "cut at 5 min" and "cut at 15
 * min"; it cannot resolve differences of seconds.
 */
import { decidePaperExit, type ExitDecisionParams, type ExitReason } from "@/lib/paper/exit-decision";

/** One sampled point on a position's path. */
export type PathMark = {
  ageS: number;
  pct: number;
  peakPct: number;
  lastTradeAgeS: number | null;
};

export type ExitPolicy = ExitDecisionParams & {
  name: string;
  /** Cut when the coin has had no trade for this many seconds AND is not in profit. */
  deadFlowSec?: number;
};

export type SimResult = {
  /** Age at which the policy would have exited; null = it held to the end of the path. */
  exitAgeS: number | null;
  reason: ExitReason | "dead_flow";
  /** P&L fraction at that exit, from the mark. */
  pctAtExit: number | null;
};

/**
 * Walk the path and return the first exit the policy would have taken.
 * Marks must be ordered oldest-first.
 */
export function simulateExit(path: readonly PathMark[], policy: ExitPolicy): SimResult {
  for (const m of path) {
    if (
      policy.deadFlowSec != null &&
      policy.deadFlowSec > 0 &&
      m.lastTradeAgeS != null &&
      m.lastTradeAgeS >= policy.deadFlowSec &&
      m.pct <= 0
    ) {
      return { exitAgeS: m.ageS, reason: "dead_flow", pctAtExit: m.pct };
    }
    const reason = decidePaperExit(m.pct, m.peakPct, m.ageS * 1000, policy);
    if (reason) return { exitAgeS: m.ageS, reason, pctAtExit: m.pct };
  }
  return { exitAgeS: null, reason: null, pctAtExit: path.length ? path[path.length - 1]!.pct : null };
}

export type PolicyScore = {
  name: string;
  trades: number;
  /** Sum of simulated P&L in SOL. */
  pnlSol: number;
  wins: number;
  winPct: number;
  avgHoldMin: number;
  /** Total minutes of slot time the policy consumes. Lower frees more capacity. */
  slotMinutes: number;
  /** Trades exited BELOW what they actually realized, and the P&L given up. */
  winnersClipped: number;
  pnlGivenUp: number;
};

export type ScoredTrade = {
  /** Cost basis, for turning a P&L fraction into SOL. */
  sizeSol: number;
  /** What the trade actually realized, in SOL. */
  actualPnlSol: number;
  /** Actual hold, minutes. Used when a policy never exits within the path. */
  actualHoldMin: number;
  path: readonly PathMark[];
};

/** Score one policy across many trades. */
export function scorePolicy(trades: readonly ScoredTrade[], policy: ExitPolicy): PolicyScore {
  let pnl = 0;
  let wins = 0;
  let holdMin = 0;
  let clipped = 0;
  let givenUp = 0;
  for (const t of trades) {
    const sim = simulateExit(t.path, policy);
    // No simulated exit within the recorded path → the trade ran to its real end,
    // so it keeps its actual outcome rather than an invented one.
    const simPnl = sim.exitAgeS == null || sim.pctAtExit == null ? t.actualPnlSol : sim.pctAtExit * t.sizeSol;
    const hold = sim.exitAgeS == null ? t.actualHoldMin : sim.exitAgeS / 60;
    pnl += simPnl;
    if (simPnl > 0) wins += 1;
    holdMin += hold;
    if (simPnl < t.actualPnlSol) {
      clipped += 1;
      givenUp += t.actualPnlSol - simPnl;
    }
  }
  const n = trades.length;
  return {
    name: policy.name,
    trades: n,
    pnlSol: pnl,
    wins,
    winPct: n ? (100 * wins) / n : 0,
    avgHoldMin: n ? holdMin / n : 0,
    slotMinutes: holdMin,
    winnersClipped: clipped,
    pnlGivenUp: givenUp,
  };
}
