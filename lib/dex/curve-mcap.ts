/**
 * Pump.fun bonding-curve ↔ market-cap conversions (pure, web-safe — no DB/IO).
 *
 * On the curve, virtual_sol_reserves × virtual_token_reserves = k is constant
 * (k = 30 × 1.073e9, total supply 1e9), so the token price ∝ vSol² and the
 * market cap (price × supply) is:
 *
 *     mcap_sol  = vSol² / CURVE_DIV         (CURVE_DIV = k / supply = 32.19)
 *     mcap_usd  = mcap_sol × SOL_USD
 *
 * Inverting lets us turn a *post-graduation* DEX market cap (which pump/DexScreener
 * report live) back into an "effective vSol" that the existing quadratic PnL model
 * (lib/paper/math.ts `paperPnlSol`, which uses (cur/entry)²) consumes unchanged.
 * This is how we keep PnL honest after a coin leaves the bonding curve, where our
 * on-chain `events.v_sol_after` freezes.
 */

/** k / supply for the standard pump.fun curve (30·1.073e9 / 1e9 ≈ 32.19). */
export const CURVE_DIV = 32.19;
import { getSolUsdSync, SOL_USD_FALLBACK } from "@/lib/market/sol-usd";

/** Fallback when live price has not loaded yet. */
export const SOL_USD = SOL_USD_FALLBACK;

function solUsd(): number {
  return getSolUsdSync();
}

/**
 * Pure core: market cap (USD) from vSol at an EXPLICIT SOL/USD rate. Separated so
 * the pricing seam and its invariant tests can prove SOL-price behavior without
 * touching the process-global price cache. The exported wrapper below binds the
 * live rate.
 */
export function mcapUsdFromVSolAt(vSol: number, solUsdRate: number): number | null {
  if (!Number.isFinite(vSol) || vSol <= 0 || !Number.isFinite(solUsdRate) || solUsdRate <= 0) {
    return null;
  }
  return ((vSol * vSol) / CURVE_DIV) * solUsdRate;
}

/**
 * Pure core: effective vSol from a USD market cap at an EXPLICIT SOL/USD rate.
 * Exact inverse of {@link mcapUsdFromVSolAt} at any fixed rate (round-trip identity).
 */
export function effectiveVSolFromMcapUsdAt(
  mcapUsd: number | null | undefined,
  solUsdRate: number,
): number | null {
  if (mcapUsd == null || !Number.isFinite(mcapUsd) || mcapUsd <= 0) return null;
  if (!Number.isFinite(solUsdRate) || solUsdRate <= 0) return null;
  return Math.sqrt((mcapUsd * CURVE_DIV) / solUsdRate);
}

/** Market cap (USD) implied by a bonding-curve virtual_sol_reserves value. */
export function mcapUsdFromVSol(vSol: number): number | null {
  return mcapUsdFromVSolAt(vSol, solUsd());
}

/**
 * Effective virtual_sol_reserves that would produce `mcapUsd` on the curve.
 * Used to feed live DEX mcap into the vSol-based PnL model for graduated coins.
 */
export function effectiveVSolFromMcapUsd(mcapUsd: number | null | undefined): number | null {
  return effectiveVSolFromMcapUsdAt(mcapUsd, solUsd());
}
