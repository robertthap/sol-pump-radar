/**
 * Entry-tier control (L5.4): the learner can disable the relaxed (demo) entry
 * tier when it underperforms, so the auto-trader stops opening losing relaxed
 * entries while keeping strict-tier entries. The decision logic is pure/testable;
 * the live flag is process-local (re-derived within minutes after a restart).
 */

export type TierStat = {
  trades: number;
  winRate: number | null;
  expectancySol: number | null;
};

/**
 * Decide whether the relaxed tier should stay enabled. Not sticky — recomputed
 * from current data each tick, so it re-enables if relaxed performance recovers.
 */
export function shouldEnableRelaxedTier(
  strict: TierStat,
  relaxed: TierStat,
  minSamples = 30,
): { enabled: boolean; reason: string } {
  if (relaxed.trades < minSamples) {
    return { enabled: true, reason: `relaxed n=${relaxed.trades}<${minSamples} (insufficient — keep on)` };
  }
  if ((relaxed.expectancySol ?? 0) < 0) {
    return {
      enabled: false,
      reason: `relaxed expectancy ${(relaxed.expectancySol ?? 0).toFixed(4)} SOL < 0 on ${relaxed.trades} trades`,
    };
  }
  if (strict.trades >= minSamples && (relaxed.winRate ?? 0) < (strict.winRate ?? 0) - 0.05) {
    return {
      enabled: false,
      reason: `relaxed win ${((relaxed.winRate ?? 0) * 100).toFixed(0)}% << strict ${((strict.winRate ?? 0) * 100).toFixed(0)}%`,
    };
  }
  return {
    enabled: true,
    reason: `relaxed healthy (exp ${(relaxed.expectancySol ?? 0).toFixed(4)}, n ${relaxed.trades})`,
  };
}

let relaxedEnabled = true;

export function setRelaxedTierEnabled(v: boolean): void {
  relaxedEnabled = v;
}

export function relaxedTierEnabled(): boolean {
  return relaxedEnabled;
}
