import "server-only";

import { logger } from "@/lib/log";
import { touchWorker } from "@/lib/workers/heartbeat";
import { DEX_QUOTE_POLL_MS } from "@/lib/chart/constants";
import { fetchDexMarketBatch } from "@/lib/dex/market-snapshot";
import { insertDexQuote, fetchDexQuotes } from "@/lib/chart/data/tradeStore";
import { getChartSubscribedMints } from "@/lib/chart/runtime/chartWsServer";
import { getChartPipeline } from "@/lib/chart/runtime/chartRuntime";
import { PUMP_SUPPLY } from "@/lib/chart/constants";

const log = logger("chart-dex-quotes");

export function startChartDexQuoteLane(): () => void {
  const tick = async () => {
    const t0 = Date.now();
    try {
      const mints = getChartSubscribedMints();
      if (!mints.length) return;
      const markets = await fetchDexMarketBatch(mints);
      const pipe = getChartPipeline();
      for (const mint of mints) {
        const m = markets.get(mint);
        if (!m?.pools?.[0]?.priceUsd) continue;
        const priceUsd = m.pools[0].priceUsd;
        const mcapUsd = priceUsd * PUMP_SUPPLY;
        await insertDexQuote({ mint, priceUsd, mcapUsd, source: "dexscreener" });
        pipe.setDexQuotes(mint, await fetchDexQuotes(mint));
      }
    } catch (e) {
      log.warn("dex quote tick failed", { err: String(e) });
    } finally {
      touchWorker("chart-dex-quotes", { tickMs: Date.now() - t0 });
    }
  };

  const id = setInterval(() => void tick(), DEX_QUOTE_POLL_MS);
  void tick();
  return () => clearInterval(id);
}
