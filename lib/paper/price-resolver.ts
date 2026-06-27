import "server-only";
import type { PriceResolver, PriceQuote } from "@spr/trading";
import { resolveMintVSol } from "@/lib/pump/resolve-price";
import { resolveDexPool } from "@/lib/chart/data/dexPool";
import { fetchOnchainMcap } from "@/lib/chart/data/onchainPrice";
import { effectiveVSolFromMcapUsd } from "@/lib/pricing/seam";

/**
 * Bridges the curve-based v_sol resolver to the @spr/trading PriceResolver.
 *
 * IMPORTANT — graduated tokens: `events.v_sol_after` is only written by the
 * bonding-curve ingestor, so it FREEZES at migration. Marking a graduated
 * position against that frozen value would compute a stale PnL and never fire
 * the stop-loss/take-profit correctly. So for tokens that have a DEX pool we
 * read the live PumpSwap reserves on-chain and convert that mcap back to an
 * "effective v_sol" on the same scale the position's SL/TP/entry use.
 *
 * (The SOL/USD rate cancels in the mcap→v_sol round-trip, so this stays
 * consistent with curve-phase marking regardless of the SOL price.)
 */

// Cache graduation status (DEX pool address, or null) to avoid re-hitting the
// pool lookup for every open position on every ~2s mark-to-market tick.
const gradCache = new Map<string, { pool: string | null; at: number }>();
const GRAD_TTL_MS = 60_000;

async function poolFor(mint: string): Promise<string | null> {
  const now = Date.now();
  const cached = gradCache.get(mint);
  if (cached && now - cached.at < GRAD_TTL_MS) return cached.pool;
  let pool: string | null = null;
  try {
    pool = await resolveDexPool(mint);
  } catch {
    pool = null;
  }
  gradCache.set(mint, { pool, at: now });
  return pool;
}

async function resolveLiveVSol(mint: string): Promise<number | null> {
  const curveVSol = await resolveMintVSol(mint);

  const pool = await poolFor(mint);
  if (!pool) return curveVSol; // not graduated — curve feed is live

  // Graduated: events.v_sol_after is frozen. Use the live on-chain DEX price.
  try {
    const mcap = await fetchOnchainMcap(mint, pool);
    if (mcap && mcap > 0) {
      const v = effectiveVSolFromMcapUsd(mcap);
      if (v != null && v > 0) return v;
    }
  } catch {
    /* fall through to the (stale) curve value rather than no price */
  }
  return curveVSol;
}

export const paperPriceResolver: PriceResolver = async (
  mint: string,
): Promise<PriceQuote | null> => {
  const v = await resolveLiveVSol(mint);
  if (v == null || v <= 0) return null;
  return { mint, price: v, referenceVSol: v };
};
