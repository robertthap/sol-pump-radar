import "server-only";
import type { NormalizedMintSnapshot } from "@/lib/continuation/types";

export function computeLeadingScore(
  snap: NormalizedMintSnapshot,
  prior?: NormalizedMintSnapshot | null,
): number {
  let score = 0;
  const h1 = snap.priceChangeH1 ?? 0;
  const m5 = snap.priceChangeM5 ?? 0;

  if (prior && prior.weightedLiqUsd > 0) {
    const liqSlope = (snap.weightedLiqUsd - prior.weightedLiqUsd) / prior.weightedLiqUsd;
    if (liqSlope > 0.05 && liqSlope < 0.5) score += 0.25;
  }

  const volDeriv = snap.unifiedVol.m5 / Math.max(snap.unifiedVol.h1 / 12, 1);
  if (volDeriv > 1.1 && volDeriv < 2.5 && snap.volAcceleration < 1.5) {
    score += 0.3;
  }

  if (h1 > 5 && Math.abs(m5) < 15) {
    score += 0.25;
  }

  if (snap.buySellRatio > 1.15 && snap.buysM5 >= 2) {
    score += 0.15;
  }

  return Math.min(1, score);
}
