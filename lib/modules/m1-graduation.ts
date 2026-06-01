export const PUMP_GRADUATION_V_SOL = 85;

export type GraduationFeatures = {
  currentVSol: number | null;
  vSol5mAgo: number | null;
  curveVelocity5m: number | null;
  uniqueBuyers5m: number;
  buys5m: number;
  sells5m: number;
  buyVol5m: number;
  sellVol5m: number;
  ageSeconds: number | null;
};

export type GraduationScore = {
  score: number;
  components: {
    curveProgress: number;
    velocity: number;
    breadth: number;
    pressure: number;
    age: number;
  };
  reasons: string[];
};

function clamp(x: number, lo = 0, hi = 1): number {
  if (!Number.isFinite(x)) return lo;
  return Math.max(lo, Math.min(hi, x));
}

function sat(x: number, cap: number): number {
  return clamp(x / cap);
}

export function scoreGraduation(f: GraduationFeatures): GraduationScore {
  const curveProgress = f.currentVSol == null ? 0 : clamp(f.currentVSol / PUMP_GRADUATION_V_SOL);

  const velocityValue =
    f.curveVelocity5m != null
      ? f.curveVelocity5m
      : f.currentVSol != null && f.vSol5mAgo != null
        ? f.currentVSol - f.vSol5mAgo
        : 0;
  const velocity = sat(Math.max(0, velocityValue), 12);

  const breadth = sat(f.uniqueBuyers5m, 30);

  const totalTrades = f.buys5m + f.sells5m;
  const pressure = totalTrades === 0 ? 0.5 : (f.buys5m - f.sells5m) / totalTrades / 2 + 0.5;

  let age = 0;
  if (f.ageSeconds != null) {
    const m = f.ageSeconds / 60;
    if (m < 1) age = 0.2;
    else if (m < 5) age = 0.7;
    else if (m < 15) age = 1.0;
    else if (m < 45) age = 0.9;
    else if (m < 120) age = 0.6;
    else age = 0.3;
  }

  const score = clamp(
    0.35 * curveProgress + 0.3 * velocity + 0.2 * breadth + 0.1 * pressure + 0.05 * age,
  );

  const reasons: string[] = [];
  if (curveProgress >= 0.7) reasons.push(`curve ${Math.round(curveProgress * 100)}% to graduation`);
  if (velocity >= 0.7) reasons.push(`fast velocity (+${velocityValue.toFixed(2)} SOL/5m)`);
  if (breadth >= 0.6) reasons.push(`${f.uniqueBuyers5m} unique buyers/5m`);
  if (pressure >= 0.7) reasons.push(`buy-heavy (${f.buys5m}B/${f.sells5m}S)`);
  if (age >= 0.9) reasons.push(`prime age window`);

  return {
    score,
    components: { curveProgress, velocity, breadth, pressure, age },
    reasons,
  };
}

/** Flow-weighted graduation score for older coins with recent momentum (profit mode). */
export function scoreGraduationContinuation(f: GraduationFeatures): GraduationScore {
  const curveProgress = f.currentVSol == null ? 0 : clamp(f.currentVSol / PUMP_GRADUATION_V_SOL);

  const velocityValue =
    f.curveVelocity5m != null
      ? f.curveVelocity5m
      : f.currentVSol != null && f.vSol5mAgo != null
        ? f.currentVSol - f.vSol5mAgo
        : 0;
  const velocity = sat(Math.max(0, velocityValue), 8);

  const breadth = sat(f.uniqueBuyers5m, 20);
  const totalTrades = f.buys5m + f.sells5m;
  const pressure = totalTrades === 0 ? 0.55 : (f.buys5m - f.sells5m) / totalTrades / 2 + 0.5;
  const age = 0.7;

  const score = clamp(
    0.15 * curveProgress + 0.45 * velocity + 0.25 * breadth + 0.15 * pressure,
  );

  const reasons: string[] = ["continuation"];
  if (velocity >= 0.5) reasons.push(`momentum +${velocityValue.toFixed(2)} SOL/5m`);
  if (breadth >= 0.4) reasons.push(`${f.uniqueBuyers5m} buyers/5m`);
  if (pressure >= 0.6) reasons.push(`buy pressure (${f.buys5m}B/${f.sells5m}S)`);

  return {
    score,
    components: { curveProgress, velocity, breadth, pressure, age },
    reasons,
  };
}
