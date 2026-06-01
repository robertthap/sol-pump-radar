import "server-only";
import type { MomentumState, NormalizedMintSnapshot, StatePosterior } from "@/lib/continuation/types";

function clamp01(n: number) {
  return Math.max(0, Math.min(1, n));
}

export function computeStatePosterior(
  snap: NormalizedMintSnapshot,
  ctx: { leadingScore: number; rankVelocity: number },
): StatePosterior[] {
  const h24 = snap.priceChangeH24 ?? 0;
  const h1 = snap.priceChangeH1 ?? 0;
  const m5 = snap.priceChangeM5 ?? 0;
  const vol = snap.volAcceleration;

  const scores: Record<MomentumState, number> = {
    cold: 0.15,
    early_breakout: 0.1,
    acceleration: 0.08,
    trend: 0.1,
    parabolic: 0.05,
    exhaustion: 0.05,
    collapse: 0.02,
  };

  if (snap.weightedLiqUsd < 4_000) {
    scores.cold = 0.75;
  } else {
    scores.cold = 0.08;
  }

  if (vol > 0.4 || m5 > 8 || ctx.rankVelocity > 0.05) {
    scores.early_breakout += 0.35 + ctx.leadingScore * 0.2;
  }
  if (vol > 0.8 && h1 > 5) {
    scores.acceleration += 0.4;
  }
  if (h1 > 10 && h24 > 20 && h24 < 400) {
    scores.trend += 0.45;
  }
  if (h24 > 200 || (h1 > 80 && h24 > 150)) {
    const stillAccelerating = h1 > 15 && m5 > 8 && vol > 0.35;
    if (stillAccelerating && h1 < 60) {
      scores.early_breakout += 0.35;
      scores.acceleration += 0.25;
      scores.parabolic += 0.28;
    } else {
      scores.parabolic += 0.55;
      scores.early_breakout *= 0.5;
    }
  }
  if (h24 > 100 && h1 < -8) {
    scores.exhaustion += 0.5;
  }
  if (h1 < -25 && h24 > 50) {
    scores.collapse += 0.45;
  }

  if (ctx.leadingScore > 0.5 && h1 > 3 && vol < 1.2) {
    scores.early_breakout += 0.25;
    scores.trend += 0.15;
  }

  const sum = Object.values(scores).reduce((a, b) => a + b, 0) || 1;
  return (Object.keys(scores) as MomentumState[]).map((state) => ({
    state,
    confidence: clamp01(scores[state] / sum),
  }));
}

export function dominantState(posterior: StatePosterior[]): {
  state: MomentumState;
  confidence: number;
} {
  const sorted = [...posterior].sort((a, b) => b.confidence - a.confidence);
  return { state: sorted[0]?.state ?? "cold", confidence: sorted[0]?.confidence ?? 0 };
}
