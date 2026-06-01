import "server-only";
import type { PriceResolver, PriceQuote } from "@spr/trading";
import { resolveMintVSol } from "@/lib/pump/resolve-price";

/**
 * Bridges the existing curve-based v_sol resolver to the @spr/trading
 * PriceResolver contract. The resolver returns null when no live price is
 * available; the executor reports NO_PRICE to the caller.
 */
export const paperPriceResolver: PriceResolver = async (
  mint: string,
): Promise<PriceQuote | null> => {
  const v = await resolveMintVSol(mint);
  if (v == null || v <= 0) return null;
  return { mint, price: v, referenceVSol: v };
};
