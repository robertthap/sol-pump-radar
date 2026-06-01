/**
 * Pricing source contract. The paper executor must not call RPC directly —
 * a host (apps/worker or apps/web) injects a concrete resolver. This keeps
 * @spr/trading dependency-free and unit-testable.
 */

export type PriceQuote = {
  mint: string;
  /** Bonding-curve v_sol proxy. */
  price: number;
  /** Optional liquidity reference used by slippage. */
  referenceVSol?: number | null;
  /** Optional symbol for UI. */
  symbol?: string | null;
};

export type PriceResolver = (mint: string) => Promise<PriceQuote | null>;
