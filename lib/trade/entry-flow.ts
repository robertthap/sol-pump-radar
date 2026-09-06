/**
 * DEX order-flow entry gate (pure, testable).
 *
 * Two layers, deliberately separate:
 *
 *   BASELINE (always on, every preset) — refuse coins that are effectively not
 *   trading, or that are being actively dumped. This is not a strategy opinion;
 *   buying a coin with 0 buys and $0 of 5-minute volume is indefensible under
 *   any strategy, and it was happening: ENTRY_MODE=v2_simple reduces entry to
 *   "intelligence >= 0.5 AND rug < 0.7" and bypasses every flow check.
 *
 *   MOMENTUM (opt-in, per session) — additionally require that activity is
 *   ACCELERATING and buyers outnumber sellers. Selected via the "momentum"
 *   preset.
 *
 * Deliberately NOT gated on price. A 320-trade analysis recorded in
 * handleEntries found winners had NEGATIVE 5m price change at entry: buying an
 * already-pumping coin is buying the local top. `volAcceleration` is the honest
 * momentum signal here -- it measures whether the last 5 minutes are running hot
 * versus the coin's own hourly pace, independent of price.
 *
 * A mint with NO DexScreener snapshot passes untouched. Fresh bonding-curve
 * launches have no DEX data by definition, and the genesis path depends on that.
 */

/** The subset of DexMarketSnapshot this gate reads. */
export type FlowSnapshot = {
  buysM5: number;
  sellsM5: number;
  buySellRatio: number;
  volAcceleration: number;
  priceChangeM5: number | null;
};

export type FlowThresholds = {
  /** Minimum 5m trades (buys+sells) for the coin to count as alive. */
  minTrades: number;
  /** Reject when sellers dominate this badly AND price is not rising. */
  dumpRatio: number;
  /** Trades needed before the dumping rule is trusted at all. */
  dumpMinTrades: number;
  /** Opt-in: minimum 5m buys. 0/undefined disables. */
  minBuys?: number;
  /** Opt-in: minimum buys/sells. 0/undefined disables. */
  minRatio?: number;
  /** Opt-in: minimum volume acceleration. 0/undefined disables. */
  minVolAccel?: number;
};

/**
 * Baseline: alive, and not being dumped. Chosen against the live ledger -- it
 * rejects the 0-buy/$0-volume and 5-buy/17-sell entries that prompted this,
 * while leaving ordinary entries alone.
 */
export const BASELINE_FLOW: FlowThresholds = {
  minTrades: 5,
  dumpRatio: 0.7,
  dumpMinTrades: 6,
};

export type FlowGateResult = { allow: true } | { allow: false; reason: string };

export function passesFlowGate(
  snap: FlowSnapshot | null | undefined,
  t: FlowThresholds,
): FlowGateResult {
  // No DEX data at all: a fresh curve launch. Not this gate's business.
  if (!snap) return { allow: true };

  const trades = (snap.buysM5 ?? 0) + (snap.sellsM5 ?? 0);
  if (trades < t.minTrades) {
    return { allow: false, reason: `dead: ${trades} trades/5m < ${t.minTrades}` };
  }

  // Actively dumped: sellers dominate AND price is not rising. Both conditions,
  // so a coin that is merely rotating hands is not rejected.
  if (
    trades >= t.dumpMinTrades &&
    snap.buySellRatio < t.dumpRatio &&
    (snap.priceChangeM5 ?? 0) <= 0
  ) {
    return {
      allow: false,
      reason: `dumping: b/s ${snap.buySellRatio.toFixed(2)} < ${t.dumpRatio}, Δ5m ${(snap.priceChangeM5 ?? 0).toFixed(1)}%`,
    };
  }

  if (t.minBuys && (snap.buysM5 ?? 0) < t.minBuys) {
    return { allow: false, reason: `momentum: ${snap.buysM5} buys/5m < ${t.minBuys}` };
  }
  if (t.minRatio && (snap.buySellRatio ?? 0) < t.minRatio) {
    return { allow: false, reason: `momentum: b/s ${(snap.buySellRatio ?? 0).toFixed(2)} < ${t.minRatio}` };
  }
  if (t.minVolAccel && (snap.volAcceleration ?? 0) < t.minVolAccel) {
    return {
      allow: false,
      reason: `momentum: vol accel ${(snap.volAcceleration ?? 0).toFixed(2)} < ${t.minVolAccel}`,
    };
  }
  return { allow: true };
}

/** Merge a session's opt-in momentum thresholds onto the always-on baseline. */
export function flowThresholdsFor(params: {
  minDexBuysM5?: number;
  minDexBuySellRatio?: number;
  minDexVolAccel?: number;
}): FlowThresholds {
  return {
    ...BASELINE_FLOW,
    minBuys: params.minDexBuysM5,
    minRatio: params.minDexBuySellRatio,
    minVolAccel: params.minDexVolAccel,
  };
}

/**
 * Ease the OPT-IN momentum thresholds by `factor`, leaving the baseline exactly
 * as it is. Used by the smart-money boost: "trade a bit more readily when
 * quality wallets are involved", not "skip the safety checks".
 *
 * The baseline is deliberately untouchable here. Its two rules — the coin is
 * effectively not trading, or is being actively dumped — are not strategy
 * opinions that a strong signal can outvote. A watched wallet buying a coin
 * with 2 trades in five minutes is still a coin with 2 trades in five minutes,
 * and if the boost could relax that we would be back to the 0-buy/$0-volume
 * entries this gate was written to stop.
 *
 * minRatio is also left alone: it is a ratio, not a magnitude, and halving it
 * would flip "buyers outnumber sellers" into "sellers may outnumber buyers
 * 2:1", which is a different rule rather than a looser one.
 */
export function relaxMomentumThresholds(t: FlowThresholds, factor: number): FlowThresholds {
  const f = Math.max(0, Math.min(1, factor));
  return {
    ...t,
    minBuys: t.minBuys == null ? t.minBuys : Math.max(1, Math.floor(t.minBuys * f)),
    minVolAccel: t.minVolAccel == null ? t.minVolAccel : t.minVolAccel * f,
  };
}
