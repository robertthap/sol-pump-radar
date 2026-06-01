/** Pure eval planning (testable, no server-only). */

export type EvalPlan = {
  mints: string[];
  skipped: number;
  reasons: {
    launchHot: number;
    hot: number;
    topRank: number;
    event: number;
    cooldown: number;
  };
};

export type EvalPlanConfig = {
  topRank: number;
  skipUnchangedMs: number;
  maxEvaluate: number;
  maxLaunchHot: number;
  launchHotMints: string[];
  continuationHotMints: string[];
  lastEvalAt: Map<string, number>;
};

export function planMintsToEvaluateCore(
  mints: string[],
  rowMints: Set<string>,
  crossRank: Map<string, number>,
  triggerByMint: Map<string, { length: number }>,
  cfg: EvalPlanConfig,
  now: number,
): EvalPlan {
  const ranked = mints
    .map((mint) => ({ mint, rank: crossRank.get(mint) ?? 0 }))
    .sort((a, b) => b.rank - a.rank);

  const topRankSet = new Set(ranked.slice(0, cfg.topRank).map((r) => r.mint));
  const selected = new Set<string>();
  const reasons = {
    launchHot: 0,
    hot: 0,
    topRank: 0,
    event: 0,
    cooldown: 0,
  };

  const tryAdd = (mint: string, reason: keyof typeof reasons) => {
    if (selected.size >= cfg.maxEvaluate) return;
    if (!rowMints.has(mint)) return;
    if (selected.has(mint)) return;
    selected.add(mint);
    reasons[reason]++;
  };

  // Launch-first in hybrid mode so fresh pump mints get eval slots before DEX continuation.
  for (const mint of cfg.launchHotMints.slice(0, cfg.maxLaunchHot)) {
    tryAdd(mint, "launchHot");
  }
  for (const [mint, ev] of triggerByMint) {
    if (ev.length > 0) tryAdd(mint, "event");
  }
  for (const mint of topRankSet) tryAdd(mint, "topRank");
  for (const mint of cfg.continuationHotMints) tryAdd(mint, "hot");

  for (const { mint } of ranked) {
    if (selected.size >= cfg.maxEvaluate) break;
    if (selected.has(mint)) continue;
    const last = cfg.lastEvalAt.get(mint);
    if (last != null && now - last < cfg.skipUnchangedMs) {
      reasons.cooldown++;
      continue;
    }
    selected.add(mint);
  }

  return { mints: [...selected], skipped: mints.length - selected.size, reasons };
}
