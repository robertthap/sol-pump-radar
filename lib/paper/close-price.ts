/**
 * Sanity check for a force-close exit price (pure, testable).
 *
 * Position value on the bonding curve scales as vSol SQUARED, so any error in
 * the exit price is squared when booked. That turned a price-basis mismatch into
 * fabricated profit: `paper_positions.current_price` is written by
 * mark-to-market, which for a GRADUATED coin resolves the mcap-derived effective
 * vSol (lib/paper/price-resolver.ts resolveLiveVSol), while `entry_price` is on
 * the bonding-curve basis. Two force-close paths -- the orphan sweep
 * (`session_ended`) and the no-price timeout (`timeout_stale`) -- passed that
 * stored mark straight through as the exit price.
 *
 * Real example, position 1289: entry ~74 vSol, stored mark 785 vSol. Ratio 10.6,
 * squared = +11,115%, booked as +26.676 SOL on a 0.24 SOL position. Position
 * 1252 booked +68.6 SOL the same way.
 *
 * The normal exit path is unaffected: it goes through markPnl (lib/pricing/seam),
 * whose realizedExitVSol is anchored to the ENTRY vSol
 * (`entryVSol * sqrt(currentMcap / entryMcap)`), so both sides share a basis.
 *
 * This helper refuses a candidate price whose implied return is not physically
 * plausible for a paper fill and falls back to the entry price -- a flat close.
 * Booking 0 when the basis is unknown is honest; booking +11,115% is not.
 */

/**
 * Implied return cap. A force-close is a bookkeeping action on a position the
 * exit logic already declined to price; a genuine 10x (+900%) move that the
 * normal path never acted on is not credible, and anything past it is the
 * signature of a basis mismatch rather than a trade.
 */
export const MAX_FORCE_CLOSE_ABS_PCT = 10;

export type SafeExitResult = {
  /** The price to book at. */
  exitVSol: number;
  /** True when the candidate was rejected as implausible. */
  mismatch: boolean;
  /** Implied return of the CANDIDATE, for logging (fraction, not %). */
  impliedPct: number | null;
  reason: string | null;
};

/** Implied return of closing at `exitVSol` from `entryVSol`, on the curve model. */
export function impliedReturn(entryVSol: number, exitVSol: number): number | null {
  if (!Number.isFinite(entryVSol) || !Number.isFinite(exitVSol) || entryVSol <= 0 || exitVSol <= 0) {
    return null;
  }
  return (exitVSol / entryVSol) ** 2 - 1;
}

export function safeExitVSol(input: {
  entryVSol: number;
  /** Stored mark or resolved price; may be null/0 when nothing is known. */
  candidateVSol: number | null | undefined;
  maxAbsPct?: number;
}): SafeExitResult {
  const { entryVSol } = input;
  const cap = input.maxAbsPct ?? MAX_FORCE_CLOSE_ABS_PCT;
  const candidate = input.candidateVSol;

  if (candidate == null || !Number.isFinite(candidate) || candidate <= 0) {
    return { exitVSol: entryVSol, mismatch: false, impliedPct: null, reason: "no price — closing flat at entry" };
  }
  const implied = impliedReturn(entryVSol, candidate);
  if (implied == null) {
    return { exitVSol: entryVSol, mismatch: false, impliedPct: null, reason: "unusable entry price — closing flat" };
  }
  if (Math.abs(implied) > cap) {
    return {
      exitVSol: entryVSol,
      mismatch: true,
      impliedPct: implied,
      reason:
        `price basis mismatch: entry ${entryVSol.toFixed(2)} vs mark ${candidate.toFixed(2)} ` +
        `implies ${(implied * 100).toFixed(0)}% — closing flat instead`,
    };
  }
  return { exitVSol: candidate, mismatch: false, impliedPct: implied, reason: null };
}
