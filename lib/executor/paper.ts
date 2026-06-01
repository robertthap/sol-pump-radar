/**
 * @deprecated Use @/lib/paper/math (pure helpers) or @/lib/paper/engine
 * (engine writes — worker only). This module is preserved as a thin worker-
 * side re-export for older imports inside worker code.
 *
 * Web imports must go through @/lib/paper/math (ESLint enforces this).
 */
import "server-only";

import type { RiskBudget } from "@/lib/risk/presets";

export { paperPnlSol, type ExitReason } from "@/lib/paper/math";

import { paperPnlSol as _paperPnlSol, type ExitReason } from "@/lib/paper/math";

// `shouldExit` here keeps the legacy maxHoldMinutes shape used by lib/workers/trader.ts.
export function shouldExit(opts: {
  pctOfSize: number;
  ageMs: number;
  budget: RiskBudget;
}): ExitReason | null {
  if (opts.pctOfSize >= opts.budget.tpPct) return "tp";
  if (opts.pctOfSize <= -opts.budget.slPct) return "sl";
  if (opts.ageMs >= opts.budget.maxHoldMinutes * 60_000) return "timeout";
  return null;
}

// Re-export for backward compatibility within worker code.
export const __paperPnlSol = _paperPnlSol;
