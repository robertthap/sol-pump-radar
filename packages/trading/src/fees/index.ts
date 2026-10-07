/**
 * ONE fee model for every paper engine (M03) — PURE, no IO.
 *
 * Before this module the two paper engines disagreed. The general executor
 * charged 1.00% per side (PaperRuntimeConfig.feeBps = 100); the research engine
 * charged 1.25% (hardcoded 0.0125 in lib/workers/research-trader.ts). Both wrote
 * to the same paper_positions ledger, so a research result and a general result
 * were never comparable — and the cheaper of the two was also the wrong one.
 *
 * Neither engine charged the Solana base signature fee at all, and neither
 * modelled token-account rent or the cost of a failed transaction.
 *
 * SOURCES — every constant here is evidence or an explicitly flagged assumption.
 * None of it may be tuned to improve a backtest result.
 *
 *   curve total 1.25% (0.95% protocol + 0.30% creator)
 *       Measured over 2.3M pump.fun bonding-curve trades. This is the number the
 *       frozen strategy specification uses, and it is what replaced the old
 *       1.00%, which predates creator fees.
 *   AMM total 1.25%
 *       Measured total. The protocol/creator SPLIT is not measured, so it is
 *       recorded as unknown rather than invented.
 *   base signature fee 0.000005 SOL
 *       Solana protocol constant, 5000 lamports per signature.
 *   ATA rent 0.00203928 SOL
 *       Rent-exempt minimum for a 165-byte SPL token account. Paid on the first
 *       buy of a mint and refunded when the account is closed, so a round trip
 *       nets to zero — but an UNCLOSED position has really spent it.
 *
 * NOT VERIFIED ON CHAIN IN THIS ENVIRONMENT. The brief asks for these to be
 * checked against real pump.fun and PumpSwap transactions; this container's
 * network policy refuses Solana RPC (403 on CONNECT). Run
 * `pnpm verify:fee-model` on a machine with RPC access to confirm them against
 * live transactions before trusting a paper verdict.
 */

export type VenueFee = {
  /** Total trading fee in bps, charged per side on notional. */
  totalBps: number;
  /** Protocol share in bps, or null where the split is not measured. */
  protocolBps: number | null;
  /** Creator share in bps, or null where the split is not measured. */
  creatorBps: number | null;
};

/** pump.fun bonding curve: 0.95% protocol + 0.30% creator = 1.25%. */
export const CURVE_FEE: VenueFee = { totalBps: 125, protocolBps: 95, creatorBps: 30 };

/** PumpSwap AMM: 1.25% total; the split is not measured, so it is not asserted. */
export const AMM_FEE: VenueFee = { totalBps: 125, protocolBps: null, creatorBps: null };

/** Solana base signature fee: 5000 lamports. Paid by failed transactions too. */
export const BASE_TX_FEE_SOL = 0.000005;

/** Rent-exempt minimum for an SPL token account (165 bytes). Refundable. */
export const ATA_RENT_SOL = 0.00203928;

export type Venue = "curve" | "amm";

export function venueFee(venue: Venue): VenueFee {
  return venue === "curve" ? CURVE_FEE : AMM_FEE;
}

export type FeeModel = {
  venue: Venue;
  /** Priority fee in SOL per transaction. Paid by failed transactions too. */
  priorityFeeSol: number;
  /** Master switch: when off, every cost below is exactly zero. */
  enabled: boolean;
  /**
   * Override the venue's trading fee in bps. Only for replaying a frozen
   * specification that states its own rate — never for tuning.
   */
  tradingFeeBpsOverride?: number | null;
};

export function tradingFeeBps(model: FeeModel): number {
  if (!model.enabled) return 0;
  const override = model.tradingFeeBpsOverride;
  if (override != null && Number.isFinite(override) && override >= 0) return override;
  return venueFee(model.venue).totalBps;
}

/** Trading fee in SOL on one side of a trade. */
export function tradingFeeSol(notionalSol: number, model: FeeModel): number {
  if (!model.enabled || !(notionalSol > 0)) return 0;
  return (notionalSol * tradingFeeBps(model)) / 10_000;
}

/**
 * Network cost of ONE transaction: base signature fee plus priority fee.
 * A failed transaction pays exactly this and trades nothing, which is why
 * failedTxCostSol is the same figure rather than zero.
 */
export function txCostSol(model: FeeModel): number {
  if (!model.enabled) return 0;
  return BASE_TX_FEE_SOL + Math.max(0, model.priorityFeeSol);
}

/** A failed transaction still burns the fee payer's base + priority fee. */
export function failedTxCostSol(model: FeeModel): number {
  return txCostSol(model);
}

/**
 * Token-account rent for a position.
 *
 * `refunded` is true once the account is closed, which a completed round trip
 * does — so the round trip nets to zero. An unresolved or censored position has
 * NOT got it back, and reporting zero there would overstate the balance.
 */
export function ataRentSol(model: FeeModel, refunded: boolean): number {
  if (!model.enabled || refunded) return 0;
  return ATA_RENT_SOL;
}

export type RoundTrip = {
  entryTradingFeeSol: number;
  exitTradingFeeSol: number;
  txCostSol: number;
  rentSol: number;
  totalSol: number;
  /** Total as a fraction of the notional, the number a strategy must clear. */
  totalFraction: number;
};

/**
 * Full cost of entering and exiting one position of `notionalSol`, so the
 * break-even move is explicit rather than scattered across two engines.
 *
 * The exit fee is charged on what the position is WORTH at exit, not on the
 * entry notional. At a flat price that is `notional × (1 − entryFeeRate)`,
 * because only the deployed capital compounds (see curveExitSettlement, H02).
 */
export function roundTripCostSol(notionalSol: number, model: FeeModel): RoundTrip {
  const entryTradingFeeSol = tradingFeeSol(notionalSol, model);
  const exitTradingFeeSol = tradingFeeSol(notionalSol - entryTradingFeeSol, model);
  const tx = txCostSol(model) * 2;
  const totalSol = entryTradingFeeSol + exitTradingFeeSol + tx;
  return {
    entryTradingFeeSol,
    exitTradingFeeSol,
    txCostSol: tx,
    // A completed round trip closes the account, so rent comes back.
    rentSol: 0,
    totalSol,
    totalFraction: notionalSol > 0 ? totalSol / notionalSol : 0,
  };
}
