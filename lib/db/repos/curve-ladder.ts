import "server-only";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import {
  GRADUATION_SOL,
  isStandardCurveRow,
  levelsCrossed,
  realSolFromVSol,
  type LadderFeatures,
} from "@/lib/trade/curve-ladder";

/**
 * Live feature extraction for the CURVE LADDER rule.
 *
 * The rule's decision point is the crossing trade itself, so this looks for a
 * rung crossing in the recent past and measures the three conditions AT that
 * trade, using only trades before it. It does not evaluate "now" — a rule
 * specified at an instant cannot be re-asked ten seconds later and still mean
 * the same thing.
 *
 * Returns null when no fresh crossing exists, which is the normal case by a
 * wide margin: offline over 10,507 episodes the rule fired 29 times (0.28%).
 */

/**
 * How stale a crossing may be and still be actionable. The worker ticks every
 * ~3s, so a crossing is typically seen within one or two ticks; beyond this the
 * market has moved on and the decision is no longer the one the rule specified.
 */
const MAX_CROSSING_AGE_S = 15;

/** Enough history to form the 120s progress rate, plus headroom. */
const LOOKBACK_S = 200;

export type LadderLookup = {
  features: LadderFeatures;
  /** Seconds between the crossing trade and now. */
  ageS: number;
  /** Curve position at the crossing, for the log. */
  realSol: number;
};

export async function fetchLadderFeatures(mint: string): Promise<LadderLookup | null> {
  const res = await getDb().execute(sql`
    SELECT extract(epoch FROM ts)::float8 AS ts, wallet, side,
           sol_amount::float8 AS sol, v_sol_after::float8 AS vsol
    FROM events
    WHERE mint = ${mint}
      AND venue = 'curve'
      AND v_sol_after IS NOT NULL
      -- Anchored to the newest event, not now(): a now() window silently empties
      -- after the host sleeps and the clock jumps forward.
      AND ts >= (SELECT ts FROM events ORDER BY id DESC LIMIT 1) - interval '${sql.raw(String(LOOKBACK_S))} seconds'
    ORDER BY id ASC
  `);

  const raw = (res as unknown as { rows: Array<Record<string, unknown>> }).rows;
  const trades = raw
    .map((r) => ({
      ts: Number(r.ts),
      wallet: r.wallet == null ? null : String(r.wallet),
      side: r.side == null ? null : String(r.side),
      sol: r.sol == null ? null : Number(r.sol),
      vSol: r.vsol == null ? null : Number(r.vsol),
    }))
    // Graduated coins priced off market cap, and non-SOL-quoted curves, are not
    // standard-curve trades and must not contribute to any of these features.
    .filter((t): t is { ts: number; wallet: string | null; side: string | null; sol: number; vSol: number } =>
      isStandardCurveRow(t.vSol, t.sol),
    );

  if (trades.length < 2) return null;

  const latestTs = trades[trades.length - 1].ts;

  // Most recent rung crossing, newest first.
  for (let i = trades.length - 1; i >= 1; i--) {
    const before = realSolFromVSol(trades[i - 1].vSol);
    const after = realSolFromVSol(trades[i].vSol);
    const crossed = levelsCrossed(before, after);
    if (crossed.length === 0) continue;

    const ageS = latestTs - trades[i].ts;
    if (ageS > MAX_CROSSING_AGE_S) return null;

    // A trade vaulting several rungs at once opens an episode at each; the
    // highest is the one the curve now sits at, so that is the one we act on.
    const level = crossed[crossed.length - 1];
    const now = trades[i].ts;

    // Largest buyer's share of buy SOL over the 30s before the crossing.
    const byWallet = new Map<string, number>();
    let buyTotal = 0;
    for (let j = i - 1; j >= 0; j--) {
      if (now - trades[j].ts > 30) break;
      if (trades[j].side !== "buy") continue;
      const w = trades[j].wallet ?? "?";
      byWallet.set(w, (byWallet.get(w) ?? 0) + trades[j].sol);
      buyTotal += trades[j].sol;
    }
    // Null, not zero: no buys to measure is DATA_UNAVAILABLE, and the rule
    // treats that as a failed condition rather than as clean flow.
    const buyerConcentration30s = buyTotal > 0 ? Math.max(...byWallet.values()) / buyTotal : null;

    let past: (typeof trades)[number] | null = null;
    for (let j = i - 1; j >= 0; j--) {
      if (now - trades[j].ts >= 120) { past = trades[j]; break; }
    }
    const progressRate120s =
      past == null
        ? null
        : (realSolFromVSol(trades[i].vSol) / GRADUATION_SOL -
           realSolFromVSol(past.vSol) / GRADUATION_SOL) / 120;

    return {
      features: { level, crossingTradeSol: trades[i].sol, buyerConcentration30s, progressRate120s },
      ageS,
      realSol: after,
    };
  }

  return null;
}
