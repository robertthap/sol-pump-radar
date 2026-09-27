/**
 * CURVE LADDER — a replication of an externally-specified pump.fun curve entry
 * rule. Pure, no DB/IO.
 *
 * WHAT THIS IS, STATED PLAINLY: the source specification reports this rule as a
 * FAILURE. Scored against a matched random control it returned
 * -0.09% / -0.44% / -0.37% across three execution-cost settings — not
 * distinguishable from random. It is implemented here so that result can be
 * checked independently on our own data, which is the only way a negative
 * result becomes trustworthy. It is not a money-making strategy and nothing
 * here should be read as expecting profit.
 *
 * THE RULE. A coin on the bonding curve triggers an episode the first time its
 * real SOL crosses one of nine levels. At that crossing, using only trades that
 * landed BEFORE it, three conditions must all hold:
 *
 *   1. the trade that carried it over was small        (<= 2.93369 SOL)
 *   2. buying was not concentrated in one wallet       (<= 0.3204 share, 30s)
 *   3. the curve was climbing fast                     (>  0.00256623 /s, 120s)
 *
 * THE DEFECT, WHICH IS THE MOST IMPORTANT THING HERE. Condition 3 is
 * arithmetically impossible at the lower levels, and this module derives that
 * bound rather than asserting it: a progress rate of 0.00256623/s sustained for
 * 120 s is 0.3079 of the way to graduation, and graduation is 85.005 SOL, so the
 * curve must have gained 26.18 SOL in two minutes. A curve sitting at 25 SOL
 * cannot have gained 26.18. So the rule CANNOT FIRE at levels 5 through 25 —
 * 78% of all crossings — and only ever fires at 30, 40, 50 and 65.
 *
 * That is why the original scoring was wrong. Against an all-levels base rate
 * the rule looks like 3.27x. Matched on crossing level it is 1.09x. Any
 * evaluation that does not stratify by level will rediscover the artefact and
 * conclude the rule works. minimumFirableLevel() exists so that bound is
 * checked by a test instead of trusted in a comment — change RATE_THRESHOLD and
 * the bound moves with it.
 */

/** Virtual SOL offset baked into every standard pump.fun curve. */
export const VIRTUAL_SOL_OFFSET = 30.0;

/** Real SOL paid in at which the curve graduates to the AMM. */
export const GRADUATION_SOL = 85.005;

/**
 * The rungs. An episode opens the first time a coin's real SOL crosses each of
 * these — one episode per level per mint, never re-armed.
 */
export const LADDER_LEVELS = [5, 10, 15, 20, 25, 30, 40, 50, 65] as const;

/**
 * Frozen thresholds from the source specification. Not tuned here, and not to
 * be tuned against our own data without saying so — refitting them on the same
 * trades used to judge them is how a dead rule comes back to life.
 */
export const CURVE_LADDER = {
  /** Max SOL size of the trade that carried the curve over the level. */
  maxCrossingTradeSol: 2.93369,
  /** Max share of 30s buy volume held by the single largest buyer. */
  maxBuyerConcentration30s: 0.3204,
  /** Min (progress now - progress 120s ago) / 120. */
  minProgressRate120s: 0.00256623,
} as const;

/** Fixed order size from the specification (the source wallet's median). */
export const CURVE_LADDER_SIZE_SOL = 0.349;

/** Fallback exit: a flat timer, or graduation, whichever comes first. */
export const CURVE_LADDER_HOLD_SECONDS = 31;

/** Real SOL paid into the curve, from the virtual SOL reserve our ingest stores. */
export function realSolFromVSol(vSol: number): number {
  return vSol - VIRTUAL_SOL_OFFSET;
}

/** Fraction of the way to graduation, 0..1+. */
export function curveProgress(realSol: number): number {
  return realSol / GRADUATION_SOL;
}

/**
 * The SOL a curve must gain in the 120s window for condition 3 to pass.
 *
 * Derived, not hardcoded: rate x window x graduation. This is the number that
 * makes the lower rungs unreachable.
 */
export function minRealSolGain120s(): number {
  return CURVE_LADDER.minProgressRate120s * 120 * GRADUATION_SOL;
}

/**
 * The lowest rung at which the rule can fire at all, or null if none can.
 *
 * A curve at level L has gained at most L (it started at 0), so condition 3
 * needs L > minRealSolGain120s().
 */
export function minimumFirableLevel(): number | null {
  const need = minRealSolGain120s();
  return LADDER_LEVELS.find((l) => l > need) ?? null;
}

/** Rungs the rule can never fire at, whatever the market does. */
export function unreachableLevels(): number[] {
  const need = minRealSolGain120s();
  return LADDER_LEVELS.filter((l) => l <= need);
}

/** Point-in-time inputs, all measured from trades strictly BEFORE the crossing. */
export type LadderFeatures = {
  /** The rung being crossed. */
  level: number;
  /** SOL size of the trade that carried the curve over the rung. */
  crossingTradeSol: number;
  /**
   * Largest single buyer's share of buy SOL over the previous 30s.
   * Null when there were no buys to measure — treated as unknown, not as 0.
   */
  buyerConcentration30s: number | null;
  /**
   * (progress now - progress 120s ago) / 120.
   * Null when no trade exists 120s back, so the rate cannot be formed.
   */
  progressRate120s: number | null;
};

export type LadderSignal = {
  fire: boolean;
  level: number;
  /** Which conditions passed, for the skip log and for the evaluator. */
  checks: { crossingSize: boolean; concentration: boolean; progressRate: boolean };
  /** One human sentence naming the first condition that failed. */
  reason: string;
  /** True when this rung can never fire on arithmetic alone. */
  structurallyImpossible: boolean;
};

/**
 * Evaluate the rule at one crossing.
 *
 * A null feature is a FAILED condition, never a passed one. The specification is
 * explicit that a data gap is DATA_UNAVAILABLE and never a zero; a rule that
 * treats missing flow as "concentration 0, therefore fine" would buy precisely
 * the coins it has no information about.
 */
export function ladderSignal(f: LadderFeatures): LadderSignal {
  const impossible = f.level <= minRealSolGain120s();

  const crossingSize = f.crossingTradeSol <= CURVE_LADDER.maxCrossingTradeSol;
  const concentration =
    f.buyerConcentration30s != null && f.buyerConcentration30s <= CURVE_LADDER.maxBuyerConcentration30s;
  const progressRate =
    f.progressRate120s != null && f.progressRate120s > CURVE_LADDER.minProgressRate120s;

  const checks = { crossingSize, concentration, progressRate };
  const fire = crossingSize && concentration && progressRate;

  let reason: string;
  if (fire) {
    reason = `ladder ${f.level} SOL: crossing ${f.crossingTradeSol.toFixed(2)} SOL, conc ${(f.buyerConcentration30s ?? 0).toFixed(3)}, rate ${(f.progressRate120s ?? 0).toFixed(5)}`;
  } else if (!crossingSize) {
    reason = `crossing trade ${f.crossingTradeSol.toFixed(2)} SOL > ${CURVE_LADDER.maxCrossingTradeSol}`;
  } else if (!concentration) {
    reason =
      f.buyerConcentration30s == null
        ? "buyer concentration unavailable (no buys in the last 30s)"
        : `buyer concentration ${f.buyerConcentration30s.toFixed(3)} > ${CURVE_LADDER.maxBuyerConcentration30s}`;
  } else {
    reason =
      f.progressRate120s == null
        ? "progress rate unavailable (no trade 120s back)"
        : impossible
          ? `progress rate ${f.progressRate120s.toFixed(5)} <= ${CURVE_LADDER.minProgressRate120s} — unreachable at level ${f.level}, which needs a ${minRealSolGain120s().toFixed(2)} SOL gain it cannot have made`
          : `progress rate ${f.progressRate120s.toFixed(5)} <= ${CURVE_LADDER.minProgressRate120s}`;
  }

  return { fire, level: f.level, checks, reason, structurallyImpossible: impossible };
}

/**
 * Which rungs a curve crossed on a single trade.
 *
 * A large buy can vault several rungs at once; each is its own episode, and the
 * rule is evaluated separately at each. Returns them in ascending order.
 */
export function levelsCrossed(realSolBefore: number, realSolAfter: number): number[] {
  if (!(realSolAfter > realSolBefore)) return [];
  return LADDER_LEVELS.filter((l) => realSolBefore < l && realSolAfter >= l);
}

/**
 * Is this row a plausible standard-curve trade?
 *
 * Our `events` feed carries rows whose v_sol_after sits far outside the curve's
 * arithmetic range (we see up to 3390 against a 115.005 ceiling) — graduated
 * coins priced off market cap, and non-SOL-quoted curves that report zero. The
 * specification is explicit that these are excluded AND COUNTED, never silently
 * dropped by a price filter, because a filter that quietly eats them turns a
 * venue-mixing bug into a plausible-looking result.
 */
export function isStandardCurveRow(vSolAfter: number | null, solAmount: number | null): boolean {
  if (vSolAfter == null || !Number.isFinite(vSolAfter)) return false;
  if (solAmount == null || !Number.isFinite(solAmount) || solAmount <= 0) return false;
  return vSolAfter >= VIRTUAL_SOL_OFFSET && vSolAfter <= VIRTUAL_SOL_OFFSET + GRADUATION_SOL;
}
