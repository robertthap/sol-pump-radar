import "server-only";

import { fetchDexMarketBatch } from "@/lib/dex/market-snapshot";
import { PUMP_SUPPLY } from "@/lib/chart/constants";
import { fetchDexQuotes, insertDexQuote } from "@/lib/chart/data/tradeStore";
import type { DexQuoteRow } from "@/lib/chart/types";

/** Pull a live DexScreener price, persist it, and return the latest row. */
export async function refreshDexQuoteForMint(mint: string): Promise<DexQuoteRow | null> {
  try {
    const markets = await fetchDexMarketBatch([mint]);
    const m = markets.get(mint);
    const priceUsd = m?.pools?.[0]?.priceUsd;
    if (priceUsd == null || !Number.isFinite(priceUsd) || priceUsd <= 0) return null;

    const mcapUsd = priceUsd * PUMP_SUPPLY;
    await insertDexQuote({ mint, priceUsd, mcapUsd, source: "dexscreener" });
    const quotes = await fetchDexQuotes(mint);
    return quotes[quotes.length - 1] ?? null;
  } catch {
    return null;
  }
}
