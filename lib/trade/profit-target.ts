/**
 * Fixed-dollar profit targets (pure).
 *
 * The operator's ask is "put in 0.1 SOL, take $2 out, every time" - a CASH
 * target, not a percentage. Percentages are what the exit engine speaks, so
 * this converts, and it does so honestly: the conversion has to clear the same
 * round-trip friction the executor charges, or the target books short every
 * single time.
 *
 * Friction, from packages/trading/src/paper/executor.ts:
 *   exit fee     = grossOut * feeBps/10_000        (proportional, charged on the way out)
 *   priority fee = priorityFeeSol * 2              (FLAT, charged for the round trip)
 *   cashIn       = grossOut - exitFee - priorityRoundTrip
 *   pnl          = cashIn - notional
 *
 * The flat leg is what makes small stakes expensive: 0.001 SOL is 1% of a
 * 0.1 SOL position but 10% of a 0.01 SOL one. Halving the stake does NOT halve
 * the move you need - it raises it. requiredGrossRatio() shows that directly,
 * and it is why sizing down to "risk less per trade" quietly makes the target
 * harder rather than safer.
 */

export type FrictionModel = {
  /** Proportional fee per side, in basis points (executor default: 100 = 1%). */
  feeBps: number;
  /** Flat priority fee per leg in SOL; charged twice (entry + exit). */
  priorityFeeSol: number;
};

export const DEFAULT_FRICTION: FrictionModel = { feeBps: 100, priorityFeeSol: 0.0005 };

/**
 * The gross value ratio a position must reach for the operator to net
 * `targetSol` on a `notionalSol` stake.
 *
 * Returns null when the target is unreachable in principle - which happens for
 * real: a target below the flat fee cannot be met at any price.
 */
export function requiredGrossRatio(opts: {
  notionalSol: number;
  targetSol: number;
  friction?: FrictionModel;
}): number | null {
  const { notionalSol, targetSol } = opts;
  const f = opts.friction ?? DEFAULT_FRICTION;
  if (!(notionalSol > 0) || !Number.isFinite(targetSol)) return null;

  const feeMul = 1 - f.feeBps / 10_000; // what survives the exit fee
  if (feeMul <= 0) return null;
  const flat = f.priorityFeeSol * 2;

  // cashIn = gross*feeMul - flat ; pnl = cashIn - notional = target
  const gross = (notionalSol + targetSol + flat) / feeMul;
  const ratio = gross / notionalSol;
  return Number.isFinite(ratio) && ratio > 0 ? ratio : null;
}

/** Net return as a fraction of stake, i.e. what the exit engine calls takeProfitPct. */
export function requiredNetPct(opts: {
  notionalSol: number;
  targetSol: number;
  friction?: FrictionModel;
}): number | null {
  const r = requiredGrossRatio(opts);
  if (r == null) return null;
  return r * (1 - (opts.friction ?? DEFAULT_FRICTION).feeBps / 10_000) - 1 - (2 * (opts.friction ?? DEFAULT_FRICTION).priorityFeeSol) / opts.notionalSol;
}

/**
 * Bonding-curve move required, in vSol terms.
 *
 * Position value scales as (vSol_now / vSol_entry)^2, so the vSol move needed is
 * the square root of the value ratio - a +15.5% value gain is only a +7.5% vSol
 * move. Worth surfacing: the two numbers differ by a factor of two and quoting
 * the wrong one makes the target look twice as hard, or twice as easy, as it is.
 */
export function requiredVSolMovePct(opts: {
  notionalSol: number;
  targetSol: number;
  friction?: FrictionModel;
}): number | null {
  const r = requiredGrossRatio(opts);
  return r == null ? null : Math.sqrt(r) - 1;
}

export type ProfitTargetPlan = {
  /** takeProfitPct for the exit engine. */
  netPct: number;
  /** Gross value ratio the mark must reach. */
  grossRatio: number;
  /** vSol move required, as a fraction. */
  vSolMovePct: number;
  /** The cash target restated in SOL, for logging. */
  targetSol: number;
  /** True when friction alone makes this target implausible on this stake. */
  implausible: boolean;
  reason: string;
};

/**
 * Turn "$2 on this position" into everything the rest of the system needs.
 *
 * `implausible` is the guard rail. A target that needs the coin to more than
 * double is not a "small fast profit" however it was phrased, and silently
 * accepting it would produce a bot that holds every position to timeout waiting
 * for a move that does not come - which looks exactly like the bot being broken.
 */
export function planProfitTarget(opts: {
  notionalSol: number;
  targetUsd: number;
  solUsd: number;
  friction?: FrictionModel;
  /** Above this net return the target is flagged implausible. Default +100%. */
  maxNetPct?: number;
}): ProfitTargetPlan | null {
  const { notionalSol, targetUsd, solUsd } = opts;
  if (!(notionalSol > 0) || !(solUsd > 0) || !Number.isFinite(targetUsd)) return null;

  const targetSol = targetUsd / solUsd;
  const grossRatio = requiredGrossRatio({ notionalSol, targetSol, friction: opts.friction });
  if (grossRatio == null) return null;

  const f = opts.friction ?? DEFAULT_FRICTION;
  const netPct = grossRatio * (1 - f.feeBps / 10_000) - 1 - (2 * f.priorityFeeSol) / notionalSol;
  const vSolMovePct = Math.sqrt(grossRatio) - 1;
  const cap = opts.maxNetPct ?? 1.0;
  const implausible = netPct > cap;

  return {
    netPct,
    grossRatio,
    vSolMovePct,
    targetSol,
    implausible,
    reason: implausible
      ? `$${targetUsd} on ${notionalSol} SOL needs +${(netPct * 100).toFixed(0)}% net (+${(vSolMovePct * 100).toFixed(0)}% vSol) — raise the stake or lower the target`
      : `$${targetUsd} on ${notionalSol} SOL = +${(netPct * 100).toFixed(1)}% net (+${(vSolMovePct * 100).toFixed(1)}% vSol)`,
  };
}
