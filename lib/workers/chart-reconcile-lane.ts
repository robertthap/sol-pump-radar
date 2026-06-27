import "server-only";

import { RECONCILE_INTERVAL_MS, CHECKPOINT_TIME_MS, DEFAULT_CHART_TF, CHECKPOINT_CANDLE_COUNT } from "@/lib/chart/constants";
import { logger } from "@/lib/log";
import { touchWorker } from "@/lib/workers/heartbeat";
import { getChartCache, persistEvictedMint, touchChartMint, bumpChartSeq } from "@/lib/chart/runtime/chartRuntime";
import { getChartActiveMints } from "@/lib/chart/data/chartActiveMints";
import { getChartSubscribedMints, broadcastChart } from "@/lib/chart/runtime/chartWsServer";
import { fetchDexQuotes, fetchStreamState, fetchTrades, saveCheckpoint } from "@/lib/chart/data/tradeStore";
import { buildCommittedBatch, reconcileWindow } from "@/lib/chart/engine/reconcile";
import { replayTrades } from "@/lib/chart/data/candleBuilder";
import { envelope } from "@/lib/chart/realtime/eventRouter";

const log = logger("chart-reconcile");
const lastCheckpointAt = new Map<string, number>();

async function maybeCheckpoint(mint: string): Promise<void> {
  const now = Date.now();
  const last = lastCheckpointAt.get(mint) ?? 0;
  if (now - last < CHECKPOINT_TIME_MS) return;
  lastCheckpointAt.set(mint, now);
  const cache = getChartCache();
  const stream = await fetchStreamState(mint);
  if (!stream) return;
  const candles = cache.getTailCandles(mint, DEFAULT_CHART_TF);
  await saveCheckpoint({
    mint,
    tf: DEFAULT_CHART_TF,
    epoch: stream.epoch,
    lastTradeId: stream.lastTradeId,
    candlesJson: candles.slice(-CHECKPOINT_CANDLE_COUNT),
    checksum: null,
  });
}

export function startChartReconcileLane(): () => void {
  const tick = async () => {
    const t0 = Date.now();
    try {
      const cache = getChartCache();
      const evicted = cache.evictCold();
      for (const mint of evicted) {
        await persistEvictedMint(mint);
      }

      const mints = [...new Set([...getChartSubscribedMints(), ...getChartActiveMints()])];
      for (const mint of mints) {
        await touchChartMint(mint);
        const entry = cache.get(mint);
        if (!entry) continue;
        const stream = (await fetchStreamState(mint)) ?? entry.stream;
        const liveCandles = entry.aggregator.aggs[DEFAULT_CHART_TF].getCandlesSorted();
        const raw = await fetchTrades(mint, { limit: 300 });
        const quotes = await fetchDexQuotes(mint);
        const result = reconcileWindow({
          tf: DEFAULT_CHART_TF,
          liveCandles,
          rawTrades: raw,
          stream,
          quotes,
        });
        if (result.drift && result.patches.length) {
          const committed = buildCommittedBatch(raw, stream, quotes);
          entry.aggregator.aggs[DEFAULT_CHART_TF] = replayTrades(DEFAULT_CHART_TF, committed);
          const replayed = entry.aggregator.aggs[DEFAULT_CHART_TF].getCandlesSorted();
          const last = replayed[replayed.length - 1];
          const st = await bumpChartSeq(mint);
          broadcastChart(
            mint,
            envelope("RECONCILE_PATCH", {
              mint,
              epoch: st.epoch,
              seq: st.lastSeq,
              lastTradeId: st.lastTradeId.toString(),
            }, {
              mint,
              epoch: st.epoch,
              seq: st.lastSeq,
              lastTradeId: st.lastTradeId.toString(),
              trades: [],
              candlePatches: result.patches,
              marketCap: last ? last.close * 1e9 : 0,
              regime: st.regime,
            }),
          );
        }
        await maybeCheckpoint(mint);
      }
    } catch (e) {
      log.warn("reconcile tick failed", { err: String(e) });
    } finally {
      touchWorker("chart-reconcile", { tickMs: Date.now() - t0 });
    }
  };

  const id = setInterval(() => void tick(), RECONCILE_INTERVAL_MS);
  return () => clearInterval(id);
}
