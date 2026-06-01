/**
 * M4 — Creator trust
 *
 * Measures how trustworthy the meme-coin creator is based on their history of
 * launches: graduations vs rugs, spam_score, recency. A new creator with no
 * history scores neutral (0.5). A creator with multiple rugs scores high (bad);
 * a creator with multiple graduations scores low (good).
 *
 * Returned `score` semantics: 0 = trustworthy creator, 1 = untrustworthy.
 * The decision worker subtracts this from the buy-side / adds it to the rug-side.
 */
export type CreatorFeatures = {
  launches: number;
  graduations: number;
  rugs: number;
  spamScore: number | null;
  medianTimeToDumpSec: number | null;
};

export type CreatorScore = {
  score: number;
  reasons: string[];
};

function clamp01(x: number) {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

export function scoreCreator(f: CreatorFeatures): CreatorScore {
  // No history → neutral mid-score, slightly cautious.
  if (f.launches === 0) {
    return { score: 0.5, reasons: ["no creator history"] };
  }
  const reasons: string[] = [];

  const rugRate = f.launches > 0 ? f.rugs / f.launches : 0;
  const gradRate = f.launches > 0 ? f.graduations / f.launches : 0;
  if (rugRate >= 0.5) reasons.push(`creator rugs ${(rugRate * 100).toFixed(0)}% of launches`);
  if (gradRate >= 0.3) reasons.push(`creator graduates ${(gradRate * 100).toFixed(0)}% of launches`);

  // Spam: many launches with little volume on each is a red flag.
  const spam = clamp01(f.spamScore ?? 0);
  if (spam >= 0.6) reasons.push(`spam-creator score ${spam.toFixed(2)}`);

  // Time-to-dump: < 5 min median = pure rug operator
  let dumpPenalty = 0;
  if (f.medianTimeToDumpSec != null && f.medianTimeToDumpSec > 0 && f.medianTimeToDumpSec < 300) {
    dumpPenalty = 0.6;
    reasons.push(`prior coins dumped within ${Math.round(f.medianTimeToDumpSec)}s on average`);
  }

  // Combine: rug rate dominates, spam and dump add, graduation history offsets.
  const raw = 0.6 * rugRate + 0.2 * spam + 0.2 * dumpPenalty - 0.4 * gradRate;
  // Slightly nudge the no-data case toward 0.4 (cautious-but-not-blocking)
  // when the creator is new but not fully unproven.
  const adjusted = f.launches < 3 ? raw * 0.7 + 0.3 : raw;
  return { score: clamp01(adjusted), reasons };
}
