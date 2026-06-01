/**
 * Imitation penalty (Luo et al. WWW '26, §5.3, Theorem 2).
 *
 * The pump.fun bonding curve uses constant-product virtual reserves with
 * effective SOL reserve X = x' + Σ deposited_sol and effective token reserve
 * Y. For a smart-money buy of token quantity q at reserve Y, SOL outlay is:
 *
 *     Δx_S(Y, q) = k·q / (Y · (Y - q))
 *
 * A copier executing immediately after sees the post-trade reserve (Y - q) and
 * pays:
 *
 *     Δx_C(Y, q) = k·q / ((Y - q) · (Y - 2q))
 *
 * Therefore the copier's relative execution cost is
 *
 *     Δx_C / Δx_S = Y / (Y - 2q)         (Theorem 2)
 *
 * That ratio - 1 = 2q / (Y - 2q) ≈ 2q/Y for q << Y is the imitation penalty
 * we add to expected slippage.
 *
 * In our system we don't always know token Y reserve directly, but we know
 *   - vSol = effective SOL-side reserve X
 *   - sizeSol = SOL we want to spend
 *
 * Using the symmetric pump.fun curve with x'·y' = k, the proportional price
 * impact of a buy of size sizeSol at vSol X is approximately:
 *
 *     impact_sm  ≈ sizeSol / X
 *     impact_co  ≈ sizeSol / (X - sizeSol)   (copier sees post-trade reserve)
 *
 * → imitation penalty ≈ impact_co - impact_sm = sizeSol^2 / (X · (X - sizeSol))
 *   ≈ (sizeSol / X)^2  for small sizeSol.
 *
 * For practical safety we cap and floor.
 */
export function imitationPenaltyPct(sizeSol: number, vSol: number | null): number {
  if (!vSol || vSol <= 0 || sizeSol <= 0) return 0;
  if (sizeSol >= vSol * 0.4) return 0.15; // panic cap when liquidity is shallow
  const r = sizeSol / vSol;
  // Penalty ≈ r^2 plus 1% baseline pump.fun fee already in budget.
  const raw = r * r;
  return Math.min(0.12, Math.max(0, raw));
}

/**
 * Total expected slippage for a copier-style buy: bonding-curve impact for
 * the copier's worse reserve plus the imitation penalty already baked in.
 */
export function copierExpectedImpactPct(sizeSol: number, vSol: number | null): number {
  if (!vSol || vSol <= 0 || sizeSol <= 0) return 0.05;
  if (sizeSol >= vSol * 0.4) return 0.25;
  const post = vSol - sizeSol;
  if (post <= 0) return 0.5;
  return Math.min(0.5, sizeSol / post);
}
