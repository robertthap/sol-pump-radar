import { NextResponse } from "next/server";
import { fetchDexMarketBatch } from "@/lib/dex/market-snapshot";
import { cached } from "@/lib/api/short-cache";
import { PUMP_SUPPLY } from "@/lib/pump/program";
import { resolveDexPool } from "@/lib/dex/dex-pool";
import { fetchOnchainMcap } from "@/lib/dex/onchain-price";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Real-time live price for the focused chart token.
 *
 * Primary source is the PumpSwap pool's ON-CHAIN reserves (via Helius) — the
 * current slot's state, the same data DexScreener's website uses, so it's
 * genuinely live. DexScreener's public REST API lags ~30-60s (cached server-side)
 * and GeckoTerminal's OHLCV lags ~20s, so both are kept only as a fallback.
 * Cached 2 s; the chart polls every ~2.5 s.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ mint: string }> },
) {
  const { mint } = await params;
  if (!mint || mint.length < 32) {
    return NextResponse.json({ error: "invalid_mint" }, { status: 400 });
  }
  const payload = await cached(`liveprice:${mint}`, 1_000, async () => {
    const pool = await resolveDexPool(mint);
    // 1) Real-time on-chain reserves (PumpSwap).
    if (pool) {
      try {
        const mc = await fetchOnchainMcap(mint, pool);
        if (mc && mc > 0) {
          return { mcapUsd: mc, priceUsd: mc / PUMP_SUPPLY, source: "onchain" };
        }
      } catch {
        /* fall through to DexScreener */
      }
    }
    // 2) Fallback: DexScreener REST (lagged, but better than nothing).
    try {
      const markets = await fetchDexMarketBatch([mint]);
      const m = markets.get(mint);
      const priceUsd = m?.pools?.[0]?.priceUsd ?? null;
      return {
        priceUsd,
        mcapUsd: priceUsd && priceUsd > 0 ? priceUsd * PUMP_SUPPLY : null,
        source: "dexscreener",
      };
    } catch {
      return { priceUsd: null, mcapUsd: null, source: "none" };
    }
  });
  return NextResponse.json(payload);
}
