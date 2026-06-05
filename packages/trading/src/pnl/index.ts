/**
 * Long-only PnL math (paper engine current scope). PnL is in SOL.
 *
 * IMPORTANT — bonding-curve basis. The paper price resolver reports the
 * bonding-curve `v_sol` as the "price" (see lib/paper/price-resolver.ts). On
 * pump.fun's constant-product curve the token price scales as v_sol², so a
 * position's SOL value scales as (v_sol_now / v_sol_entry)². The linear
 * `*PnlSol(price, qty)` helpers below therefore UNDERSTATE PnL when fed v_sol
 * directly. Use the `curve*` helpers (which square the v_sol ratio) for any PnL
 * derived from the v_sol proxy so realized booking matches the exit-decision and
 * UI math in lib/paper/math.ts (paperPnlSol) and lib/paper/mcap-pnl.ts.
 *
 * The linear helpers are kept for callers that already hold a *true* price.
 */

export function unrealizedPnlSol(
  entryPrice: number,
  currentPrice: number,
  quantity: number,
): number {
  return (currentPrice - entryPrice) * quantity;
}

export function realizedPnlSol(
  entryPrice: number,
  exitPrice: number,
  quantity: number,
  feesSol = 0,
): number {
  return (exitPrice - entryPrice) * quantity - feesSol;
}

export function pctOfSize(entryPrice: number, currentPrice: number): number {
  if (entryPrice <= 0) return 0;
  return (currentPrice - entryPrice) / entryPrice;
}

/**
 * Bonding-curve value multiple: how much a position's SOL value has scaled,
 * given entry and current v_sol. value(now)/value(entry) = (vNow / vEntry)².
 * Returns 1 (flat) for non-positive entry or invalid current.
 */
export function curveValueRatio(entryVSol: number, currentVSol: number): number {
  if (!(entryVSol > 0) || !Number.isFinite(currentVSol) || currentVSol < 0) return 1;
  return (currentVSol / entryVSol) ** 2;
}

/**
 * Curve-aware realized PnL in SOL. `costBasisSol` is the SOL committed to the
 * (fraction of the) position being closed (notional_sol), so the result equals
 * the net change in balance for that close (minus fees).
 */
export function curveRealizedPnlSol(
  entryVSol: number,
  exitVSol: number,
  costBasisSol: number,
  feesSol = 0,
): number {
  return costBasisSol * (curveValueRatio(entryVSol, exitVSol) - 1) - feesSol;
}

/** Curve-aware unrealized PnL in SOL (same basis as curveRealizedPnlSol). */
export function curveUnrealizedPnlSol(
  entryVSol: number,
  currentVSol: number,
  costBasisSol: number,
): number {
  return costBasisSol * (curveValueRatio(entryVSol, currentVSol) - 1);
}
