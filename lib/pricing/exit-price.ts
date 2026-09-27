/**
 * Exit-tick price selection for an OPEN paper position (PURE — no DB/IO).
 *
 * Closes a bug class where MISSING data manufactured trades. After a coin
 * graduates, the bonding-curve price is frozen and every curve fallback sits on a
 * different basis from a graduated entry. The old exit resolver decided
 * "graduated" from the pump.fun API alone, so when that response was missing it
 * marked the coin against the curve price.
 *
 * Real example, position 1411: a flat ~$60M coin (last marks -3.5%, -2.8%, -2.2%)
 * entered at 4245.68 on the mcap basis. One tick had no pump.fun data, the curve
 * resolver returned 24.14, the curve model read -99.99%, the stop-loss fired and
 * -101% was booked. Positions 1457 and 1418 went the same way.
 *
 * Prices now come from the chain (lib/pricing/live-price.ts). The rule that stays:
 * an off-curve position is priced from its pool or not at all. Missing data means
 * "no price this tick", never a change of basis.
 */

/**
 * Highest entry price a genuine bonding-curve fill can have. The curve completes
 * at ~115 virtual SOL and paper slippage (at most 1.5%) can lift a fill to ~116.7.
 * An entry above this was priced from a pool or market cap, not from the curve.
 */
export const MAX_ON_CURVE_ENTRY_V_SOL = 125;

function positive(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * True when the curve price must not be used for this position: the chain reports
 * it graduated now, an earlier tick saw it graduated (graduation is one-way), or
 * its entry price is beyond anything the curve can produce.
 */
export function isOffCurvePosition(i: {
  entryVSol: number;
  graduatedSeen: boolean;
  graduatedNow: boolean;
}): boolean {
  return (
    i.graduatedNow ||
    i.graduatedSeen ||
    (Number.isFinite(i.entryVSol) && i.entryVSol > MAX_ON_CURVE_ENTRY_V_SOL)
  );
}

/** Structural subset of lib/pricing/live-price.ts LivePrice (kept IO-free here). */
export type LivePriceLike =
  | { phase: "curve"; vSol: number }
  | { phase: "graduated"; vSol: number }
  | { phase: "unknown"; reason: string };

export type ExitPriceInput = {
  entryVSol: number;
  /** Sticky: an earlier exit tick saw this coin graduated. */
  graduatedSeen: boolean;
  /** This tick's on-chain price. */
  live: LivePriceLike;
  /** Ingested curve price (events). Only consulted for an on-curve position whose live read failed. */
  curveVSol: number | null;
};

export type ExitPrice =
  | { priced: true; vSol: number; offCurve: boolean }
  | { priced: false; offCurve: boolean; reason: string };

export function selectExitPrice(i: ExitPriceInput): ExitPrice {
  const offCurve = isOffCurvePosition({
    entryVSol: i.entryVSol,
    graduatedSeen: i.graduatedSeen,
    graduatedNow: i.live.phase === "graduated",
  });

  if (i.live.phase === "graduated") {
    const v = positive(i.live.vSol);
    return v != null
      ? { priced: true, vSol: v, offCurve: true }
      : { priced: false, offCurve: true, reason: "graduated coin has no pool price" };
  }

  if (i.live.phase === "curve") {
    // The chain says the curve is still live. A position entered above the curve's
    // range cannot be marked against it, whatever an earlier tick believed.
    if (Number.isFinite(i.entryVSol) && i.entryVSol > MAX_ON_CURVE_ENTRY_V_SOL) {
      return { priced: false, offCurve: true, reason: "entry price is not on the curve basis" };
    }
    const v = positive(i.live.vSol);
    return v != null
      ? { priced: true, vSol: v, offCurve: false }
      : { priced: false, offCurve: false, reason: "no curve price" };
  }

  // Live read failed.
  if (offCurve) {
    return { priced: false, offCurve, reason: `graduated position unpriced: ${i.live.reason}` };
  }
  const curve = positive(i.curveVSol);
  if (curve != null) return { priced: true, vSol: curve, offCurve };
  return { priced: false, offCurve, reason: `no price: ${i.live.reason}` };
}

/**
 * Candidate exit price for a force-close (the no-price timeout and the orphan
 * sweep). An off-curve position uses the last exit mark this loop computed on the
 * entry's own basis, or null (which safeExitVSol turns into a flat close at
 * entry). On-curve positions keep the stored mark, as before.
 */
export function forceCloseCandidateVSol(i: {
  offCurve: boolean;
  lastMarkExitVSol: unknown;
  storedCurrentPrice: number | null;
}): number | null {
  if (i.offCurve) return positive(i.lastMarkExitVSol);
  return i.storedCurrentPrice;
}
