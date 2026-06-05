/** Pure helpers for manual paper sell paths (unit-testable). */

export function isAutoPaperEntry(features: Record<string, unknown> | null): boolean {
  const f = features ?? {};
  return f.auto === true || f.auto === "true" || String(f.auto ?? "") === "true";
}

export function manualPaperExitReason(isAuto: boolean, bulk: boolean): string {
  if (isAuto) return bulk ? "manual_auto_sell_all" : "manual_auto_sell";
  return bulk ? "manual_demo_sell_all" : "manual_demo_sell";
}

/**
 * Bonding-curve mcap proxy: on pump.fun, virtual_sol_reserves × virtual_token_reserves
 * is constant, so price ∝ vSol² and mcap ∝ vSol². We back-extrapolate the entry mcap
 * from the current (authoritative) mcap via (entryVSol / currentVSol)².
 *
 * IMPORTANT: both vSol values MUST be the SAME basis (virtual_sol_reserves, i.e. our
 * `events.v_sol_after`). Mixing virtual (entry) with real_sol_reserves (pump API) makes
 * the squared ratio fabricate a mcap the coin never had.
 *
 * Virtual reserves live in ~[30, 115] SOL (launch → graduation), so a legitimate ratio
 * is bounded to ~[0.25, 4]. Anything outside that signals a basis/data mismatch (or a
 * graduated coin where this model no longer holds) → return null rather than mislead.
 */
export function estimateEntryMcapUsd(
  entryVSol: number | null,
  currentVSol: number | null,
  currentMcapUsd: number | null,
): number | null {
  if (entryVSol == null || currentVSol == null || currentMcapUsd == null) return null;
  if (entryVSol <= 0 || currentVSol <= 0) return null;
  const ratio = entryVSol / currentVSol;
  if (ratio < 0.2 || ratio > 5) return null;
  return currentMcapUsd * ratio * ratio;
}

export type SellAllScope = "all" | "auto";

export function resolveSellAllSessionFilter(
  scope: SellAllScope,
  sessionId: string | null,
): string | null {
  return scope === "auto" ? sessionId : null;
}
