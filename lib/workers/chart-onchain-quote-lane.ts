import "server-only";

import { logger } from "@/lib/log";
import { touchWorker } from "@/lib/workers/heartbeat";
import { PUMP_SUPPLY } from "@/lib/chart/constants";
import { resolveDexPool } from "@/lib/chart/data/dexPool";
import { fetchOnchainMcap } from "@/lib/chart/data/onchainPrice";
import { insertDexQuote, fetchDexQuotes } from "@/lib/chart/data/tradeStore";
import { getChartSubscribedMints } from "@/lib/chart/runtime/chartWsServer";
import { getChartPipeline } from "@/lib/chart/runtime/chartRuntime";

/**
 * Phase A1 — real-time post-graduation price from the ON-CHAIN PumpSwap reserves,
 * the same proven source as the live-price dot (lib/chart/data/onchainPrice.ts).
 *
 * Replaces the slow path for the chart you're actually viewing: instead of waiting
 * on GeckoTerminal (~20s cache) or DexScreener REST (~30-60s), this reads the pool's
 * current-slot reserves (~0.5s) every 2s and stores it as a fresh `onchain` quote.
 *
 * Scope is deliberately the SUBSCRIBED mints only (the chart on screen), so it stays
 * a handful of RPC calls — no firehose, negligible CPU. It only acts on graduated
 * coins (resolveDexPool returns a pool); pre-graduation coins keep their real-time
 * bonding-curve candles and are skipped here.
 *
 * This is the validation step: because the price comes from the same reserve
 * decoder as the live dot, a stored quote that matches the dot confirms the source
 * is correct before Phase A2 wires it into the candle tail.
 */
const log = logger("chart-onchain-quotes");
const POLL_MS = 2_000;

export function startChartOnchainQuoteLane(): () => void {
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    const t0 = Date.now();
    try {
      const mints = [...getChartSubscribedMints()];
      if (!mints.length) return;
      const pipe = getChartPipeline();
      for (const mint of mints) {
        try {
          const pool = await resolveDexPool(mint);
          if (!pool) continue; // not graduated — bonding-curve candles are already live
          const mcapUsd = await fetchOnchainMcap(mint, pool);
          if (mcapUsd == null || !(mcapUsd > 0)) continue;
          const priceUsd = mcapUsd / PUMP_SUPPLY;
          await insertDexQuote({ mint, priceUsd, mcapUsd, source: "onchain" });
          pipe.setDexQuotes(mint, await fetchDexQuotes(mint));
          log.debug("onchain quote", { mint: mint.slice(0, 8), mcapUsd: Math.round(mcapUsd) });
        } catch (e) {
          log.debug("onchain quote mint failed", { mint: mint.slice(0, 8), err: String(e) });
        }
      }
    } catch (e) {
      log.warn("onchain quote tick failed", { err: String(e) });
    } finally {
      touchWorker("chart-onchain-quotes", { tickMs: Date.now() - t0 });
      running = false;
    }
  };

  const id = setInterval(() => void tick(), POLL_MS);
  void tick();
  return () => clearInterval(id);
}
