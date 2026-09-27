import "server-only";
import type { PriceResolver, PriceQuote } from "@spr/trading";
import { fetchLivePrice } from "@/lib/pricing/live-price";

/**
 * Bridges on-chain live pricing (lib/pricing/live-price.ts) to the @spr/trading
 * PriceResolver used for paper fills, closes, partial closes and mark-to-market.
 *
 * A curve coin is priced from its bonding-curve account; a graduated coin from its
 * PumpSwap pool, as an effective vSol on the same scale as the curve. When the
 * price cannot be established the resolver returns null, and the executor refuses
 * to fill rather than fill at a stale or differently-based price. (The previous
 * version fell back to the frozen curve price, which is how graduated positions
 * came to be entered at ~115 and marked against unrelated numbers.)
 */
export const paperPriceResolver: PriceResolver = async (
  mint: string,
): Promise<PriceQuote | null> => {
  const p = await fetchLivePrice(mint);
  if (p.phase === "unknown") return null;
  return { mint, price: p.vSol, referenceVSol: p.vSol };
};
