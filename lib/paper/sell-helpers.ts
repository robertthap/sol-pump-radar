/** Pure helpers for manual paper sell paths (unit-testable). */

export function isAutoPaperEntry(features: Record<string, unknown> | null): boolean {
  const f = features ?? {};
  return f.auto === true || f.auto === "true" || String(f.auto ?? "") === "true";
}

export function manualPaperExitReason(isAuto: boolean, bulk: boolean): string {
  if (isAuto) return bulk ? "manual_auto_sell_all" : "manual_auto_sell";
  return bulk ? "manual_demo_sell_all" : "manual_demo_sell";
}

/** Bonding-curve mcap proxy: price ~ (vSol)^2 vs current mcap. */
export function estimateEntryMcapUsd(
  entryVSol: number | null,
  currentVSol: number | null,
  currentMcapUsd: number | null,
): number | null {
  if (entryVSol == null || currentVSol == null || currentMcapUsd == null) return null;
  if (entryVSol <= 0 || currentVSol <= 0) return null;
  const ratio = entryVSol / currentVSol;
  return currentMcapUsd * ratio * ratio;
}

export type SellAllScope = "all" | "auto";

export function resolveSellAllSessionFilter(
  scope: SellAllScope,
  sessionId: string | null,
): string | null {
  return scope === "auto" ? sessionId : null;
}
