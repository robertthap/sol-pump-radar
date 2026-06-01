/**
 * Regime-linked position sizing (PURE — no server-only, testable). L6.2.
 *
 * Scale trade size down in risky regimes (high riskMultiplier) and up modestly
 * in benign ones, within bounded factors. Pairs with the regime detector so the
 * system risks less when the tape is rug-heavy or thin.
 */
export function regimeSizedSol(baseSol: number, riskMultiplier: number): number {
  if (!(baseSol > 0) || !(riskMultiplier > 0)) return baseSol;
  // Inverse of risk: multiplier 1 → 1.0×; 1.25 (high_rug) → 0.8×; 0.9 (risk_on) → ~1.11×.
  const factor = Math.max(0.4, Math.min(1.2, 1 / riskMultiplier));
  return baseSol * factor;
}
