import { paperPnlSol } from "@/lib/executor/paper";

const BUY_ACTIONS = new Set(["BUY_STRONG", "BUY_MODERATE"]);

export function isBuyRecommendation(action: string): boolean {
  return BUY_ACTIONS.has(action);
}

export function signalWasTraded(executed: string): boolean {
  return executed.startsWith("executed");
}

export type MissedProfitInput = {
  action: string;
  executed: string;
  ts: string;
  vAtSignal: number | null;
  vNow: number | null;
  sizeSol: number;
  pumpFeesPct: number;
  paperSlippagePct: number;
};

export type MissedProfitFields = {
  /** ISO time when the system issued a buy recommendation (null for non-buys). */
  recommendedAt: string | null;
  /** Hypothetical paper PnL if entered at signal and held to latest v_sol (untraded buys only). */
  missedProfitSol: number | null;
  missedProfitPct: number | null;
};

export function attachMissedProfitFields(opts: MissedProfitInput): MissedProfitFields {
  if (!isBuyRecommendation(opts.action)) {
    return { recommendedAt: null, missedProfitSol: null, missedProfitPct: null };
  }

  const recommendedAt = opts.ts;

  if (signalWasTraded(opts.executed)) {
    return { recommendedAt, missedProfitSol: null, missedProfitPct: null };
  }

  if (opts.vAtSignal == null || opts.vNow == null || opts.vAtSignal <= 0) {
    return { recommendedAt, missedProfitSol: null, missedProfitPct: null };
  }

  const { pnlSol, pctOfSize } = paperPnlSol({
    sizeSol: opts.sizeSol,
    entryVSol: opts.vAtSignal,
    currentVSol: opts.vNow,
    pumpFeesPct: opts.pumpFeesPct,
    paperSlippagePct: opts.paperSlippagePct,
  });

  return {
    recommendedAt,
    missedProfitSol: pnlSol,
    missedProfitPct: pctOfSize * 100,
  };
}

export function sumMissedProfitSol(
  rows: Array<{ missedProfitSol: number | null }>,
): number {
  let sum = 0;
  for (const r of rows) {
    if (r.missedProfitSol != null && Number.isFinite(r.missedProfitSol)) {
      sum += r.missedProfitSol;
    }
  }
  return sum;
}
