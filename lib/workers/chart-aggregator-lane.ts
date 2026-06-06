import "server-only";

import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { logger } from "@/lib/log";
import { touchWorker } from "@/lib/workers/heartbeat";
import { buildCommittedBatch, reconcileWindow } from "@/lib/chart/engine/reconcile";
import { replayTrades } from "@/lib/chart/data/candleBuilder";
import { DEFAULT_CHART_TF } from "@/lib/chart/constants";
import { fetchDexQuotes, fetchStreamState, fetchTrades } from "@/lib/chart/data/tradeStore";
import { broadcastChart, getChartSubscribedMints } from "@/lib/chart/runtime/chartWsServer";
import { envelope } from "@/lib/chart/realtime/eventRouter";
import { getChartPipeline, getChartCache, touchChartMint, bumpChartSeq } from "@/lib/chart/runtime/chartRuntime";

const log = logger("chart-aggregator");

async function reconcileLateTrades(mint: string): Promise<void> {
  const pipe = getChartPipeline();
  const late = pipe.getAggregator(mint).drainLateToFinal();
  if (!late.length) return;

  const stream = (await fetchStreamState(mint)) ?? pipe.getStreamState(mint);
  const raw = await fetchTrades(mint, { limit: 300 });
  const quotes = await fetchDexQuotes(mint);
  const entry = getChartCache().get(mint);
  if (!entry) return;

  const result = reconcileWindow({
    tf: DEFAULT_CHART_TF,
    liveCandles: entry.aggregator.aggs[DEFAULT_CHART_TF].getCandlesSorted(),
    rawTrades: raw,
    stream,
    quotes,
  });
  if (!result.patches.length) return;

  if (result.drift) {
    const committed = buildCommittedBatch(raw, stream, quotes);
    entry.aggregator.aggs[DEFAULT_CHART_TF] = replayTrades(DEFAULT_CHART_TF, committed);
  }

  const st = await bumpChartSeq(mint);
  broadcastChart(
    mint,
    envelope(
      "RECONCILE_PATCH",
      {
        mint,
        epoch: st.epoch,
        seq: st.lastSeq,
        lastTradeId: st.lastTradeId.toString(),
      },
      {
        mint,
        epoch: st.epoch,
        seq: st.lastSeq,
        lastTradeId: st.lastTradeId.toString(),
        trades: buildCommittedBatch(raw, stream, quotes).slice(-late.length),
        candlePatches: result.patches,
        marketCap: late[late.length - 1]?.marketCap ?? 0,
        regime: st.regime,
      },
    ),
  );
}

export function startChartAggregatorLane(): () => void {
  const tick = async () => {
    const t0 = Date.now();
    try {
      const mints = new Set(getChartSubscribedMints());
      // Also tail mints with recent trades (last 2 min)
      const recent = await getDb().execute(sql`
        SELECT DISTINCT mint FROM events
        WHERE kind IN ('buy', 'sell') AND ts > now() - interval '2 minutes'
        LIMIT 50
      `);
      for (const r of (recent as unknown as { rows: { mint: string }[] }).rows) {
        if (r.mint) mints.add(r.mint);
      }

      const pipe = getChartPipeline();
      for (const mint of mints) {
        await touchChartMint(mint);
        const stream = pipe.getStreamState(mint);
        const raw = await fetchTrades(mint, {
          afterId: stream.lastTradeId.toString(),
          limit: 200,
        });
        for (const t of raw) pipe.stage(mint, t);
        pipe.flush(mint);
        await reconcileLateTrades(mint);
      }
    } catch (e) {
      log.warn("aggregator tick failed", { err: String(e) });
    } finally {
      touchWorker("chart-aggregator", { tickMs: Date.now() - t0 });
    }
  };

  const id = setInterval(() => void tick(), 2000);
  void tick();
  return () => clearInterval(id);
}
