import "server-only";

import type { ChartTimeframe, CommitBundle, SyncSnapshot } from "@/lib/chart/types";
import { DEFAULT_CHART_TF, CHECKPOINT_CANDLE_COUNT, CHECKPOINT_TRADE_INTERVAL } from "@/lib/chart/constants";
import { CommitPipeline } from "@/lib/chart/realtime/commitPipeline";
import { ChartMintCache } from "@/lib/chart/data/chartCache";
import { MultiTfAggregator } from "@/lib/chart/data/candleBuilder";
import {
  fetchDexQuotes,
  fetchStreamState,
  fetchTrades,
  upsertStreamState,
  saveCheckpoint,
  loadCheckpoint,
} from "@/lib/chart/data/tradeStore";
import { buildCommittedBatch } from "@/lib/chart/engine/reconcile";
import type { StreamStateRow } from "@/lib/chart/types";
import type { WsEnvelope } from "@/lib/chart/realtime/eventRouter";
import { envelope } from "@/lib/chart/realtime/eventRouter";

type BroadcastFn = (mint: string, msg: WsEnvelope) => void;

let pipeline: CommitPipeline | null = null;
let cache: ChartMintCache | null = null;
let broadcast: BroadcastFn = () => {};
const tradeCounters = new Map<string, number>();
const epochBumpedMints = new Set<string>();

async function bumpEpochOnWorkerBoot(mint: string, stream: StreamStateRow): Promise<StreamStateRow> {
  if (process.env.WORKERS !== "on") return stream;
  if (epochBumpedMints.has(mint)) return stream;
  epochBumpedMints.add(mint);
  if (stream.lastTradeId === 0n && stream.lastSeq === 0) return stream;
  const next = { ...stream, epoch: stream.epoch + 1, lastSeq: 0 };
  await upsertStreamState({
    mint,
    epoch: next.epoch,
    lastTradeId: next.lastTradeId,
    lastSeq: next.lastSeq,
    graduationAt: next.graduationAt,
    regime: next.regime,
  });
  getChartPipeline().setStreamState(mint, next);
  return next;
}

export function initChartRuntime(opts: { onBroadcast: BroadcastFn }): void {
  broadcast = opts.onBroadcast;
  cache = new ChartMintCache();
  pipeline = new CommitPipeline((bundle) => {
    void handleBundle(bundle);
  });
}

export function getChartPipeline(): CommitPipeline {
  if (!pipeline) initChartRuntime({ onBroadcast: broadcast });
  return pipeline!;
}

export function getChartCache(): ChartMintCache {
  if (!cache) initChartRuntime({ onBroadcast: broadcast });
  return cache!;
}

export async function touchChartMint(mint: string): Promise<void> {
  await ensureMint(mint);
}

async function ensureMint(mint: string): Promise<{
  stream: StreamStateRow;
  agg: MultiTfAggregator;
  tailAfterTradeId: bigint;
}> {
  const pipe = getChartPipeline();
  const c = getChartCache();
  let stream = await fetchStreamState(mint);
  if (!stream) {
    stream = {
      mint,
      epoch: 1,
      lastTradeId: 0n,
      lastSeq: 0,
      graduationAt: null,
      regime: "bonding_curve",
    };
  } else {
    stream = await bumpEpochOnWorkerBoot(mint, stream);
  }
  pipe.setStreamState(mint, stream);
  const quotes = await fetchDexQuotes(mint);
  pipe.setDexQuotes(mint, quotes);

  const cp = await loadCheckpoint(mint, DEFAULT_CHART_TF);
  const agg = pipe.getAggregator(mint);
  let tailAfterTradeId = 0n;
  if (cp?.candles?.length) {
    agg.aggs[DEFAULT_CHART_TF].loadCandles(cp.candles);
    tailAfterTradeId = cp.lastTradeId;
    if (cp.lastTradeId > stream.lastTradeId) {
      stream = { ...stream, lastTradeId: cp.lastTradeId };
    }
    pipe.setStreamState(mint, stream);
  } else {
    tailAfterTradeId = stream.lastTradeId;
  }
  c.getOrCreate(mint, stream, agg);
  return { stream, agg, tailAfterTradeId };
}

async function replayTradesIntoAgg(
  mint: string,
  stream: StreamStateRow,
  agg: MultiTfAggregator,
  afterTradeId: bigint,
): Promise<StreamStateRow> {
  const raw = await fetchTrades(mint, { afterId: afterTradeId.toString(), limit: 500 });
  if (!raw.length) return stream;
  const quotes = await fetchDexQuotes(mint);
  const committed = buildCommittedBatch(raw, stream, quotes);
  agg.applyBatch(committed);
  const last = committed[committed.length - 1]!;
  const lastId = BigInt(last.tradeId);
  if (lastId > stream.lastTradeId) {
    stream = { ...stream, lastTradeId: lastId };
    getChartPipeline().setStreamState(mint, stream);
  }
  return stream;
}

async function handleBundle(bundle: CommitBundle): Promise<void> {
  const c = getChartCache();
  c.touch(bundle.mint, bundle.trades.length);
  const existing = await fetchStreamState(bundle.mint);
  await upsertStreamState({
    mint: bundle.mint,
    epoch: bundle.epoch,
    lastTradeId: BigInt(bundle.lastTradeId),
    lastSeq: bundle.seq,
    graduationAt: bundle.regimeSwitch
      ? new Date(bundle.regimeSwitch.graduationAt)
      : existing?.graduationAt ?? null,
    regime: bundle.regime,
  });

  const n = (tradeCounters.get(bundle.mint) ?? 0) + bundle.trades.length;
  tradeCounters.set(bundle.mint, n);
  if (n >= CHECKPOINT_TRADE_INTERVAL) {
    tradeCounters.set(bundle.mint, 0);
    const candles = c.getTailCandles(bundle.mint, DEFAULT_CHART_TF);
    await saveCheckpoint({
      mint: bundle.mint,
      tf: DEFAULT_CHART_TF,
      epoch: bundle.epoch,
      lastTradeId: BigInt(bundle.lastTradeId),
      candlesJson: candles.slice(-CHECKPOINT_CANDLE_COUNT),
      checksum: null,
    });
  }

  broadcast(
    bundle.mint,
    envelope("COMMIT_BUNDLE", {
      mint: bundle.mint,
      epoch: bundle.epoch,
      seq: bundle.seq,
      lastTradeId: bundle.lastTradeId,
    }, bundle),
  );

  if (bundle.regimeSwitch) {
    broadcast(
      bundle.mint,
      envelope("REGIME_SWITCH", {
        mint: bundle.mint,
        epoch: bundle.epoch,
        seq: bundle.seq,
        lastTradeId: bundle.lastTradeId,
      }, bundle.regimeSwitch),
    );
  }
}

export async function ingestChartEvent(
  mint: string,
  raw: import("@/lib/chart/data/priceResolver").RawTradeInput,
): Promise<void> {
  await ensureMint(mint);
  getChartPipeline().stage(mint, raw);
}

export async function buildSyncSnapshot(mint: string, tf: ChartTimeframe = DEFAULT_CHART_TF): Promise<SyncSnapshot> {
  let { stream, agg, tailAfterTradeId } = await ensureMint(mint);
  stream = await replayTradesIntoAgg(mint, stream, agg, tailAfterTradeId);
  const candles = agg.aggs[tf].getCandlesSorted().slice(-CHECKPOINT_CANDLE_COUNT);
  const last = candles[candles.length - 1];
  const marketCap = last ? last.close * 1e9 : 0;
  return {
    mint,
    tf,
    epoch: stream.epoch,
    lastTradeId: stream.lastTradeId.toString(),
    candles,
    marketCap,
    regime: stream.regime,
    graduationAt: stream.graduationAt?.getTime() ?? null,
  };
}

export async function tailReplayBundles(mint: string, snapLastTradeId: string): Promise<CommitBundle[]> {
  const stream = (await fetchStreamState(mint)) ?? {
    mint,
    epoch: 1,
    lastTradeId: 0n,
    lastSeq: 0,
    graduationAt: null,
    regime: "bonding_curve" as const,
  };
  const after = BigInt(snapLastTradeId || "0");
  const raw = await fetchTrades(mint, { afterId: after.toString(), limit: 500 });
  if (!raw.length) return [];
  const quotes = await fetchDexQuotes(mint);
  const committed = buildCommittedBatch(raw, stream, quotes);
  const patchAgg = new MultiTfAggregator();
  const candlePatches = patchAgg.applyBatch(committed);
  const last = committed[committed.length - 1]!;
  return [
    {
      mint,
      epoch: stream.epoch,
      seq: stream.lastSeq + committed.length,
      lastTradeId: last.tradeId,
      trades: committed,
      candlePatches,
      marketCap: last.marketCap,
      regime: last.regime,
    },
  ];
}

export async function persistEvictedMint(mint: string): Promise<void> {
  const c = getChartCache();
  const stream = await fetchStreamState(mint);
  if (!stream) return;
  const candles = c.getTailCandles(mint, DEFAULT_CHART_TF);
  await saveCheckpoint({
    mint,
    tf: DEFAULT_CHART_TF,
    epoch: stream.epoch,
    lastTradeId: stream.lastTradeId,
    candlesJson: candles,
    checksum: null,
  });
}

export function markChartSubscribed(mint: string, on: boolean): void {
  getChartCache().markSubscribed(mint, on);
}

export async function bumpChartSeq(mint: string): Promise<StreamStateRow> {
  const st = getChartPipeline().advanceSeq(mint);
  await upsertStreamState({
    mint,
    epoch: st.epoch,
    lastTradeId: st.lastTradeId,
    lastSeq: st.lastSeq,
    graduationAt: st.graduationAt,
    regime: st.regime,
  });
  return st;
}

export async function buildCandlesFromDb(
  mint: string,
  tf: ChartTimeframe,
  opts: { beforeId?: string; limit?: number },
): Promise<{ candles: import("@/lib/chart/types").Candle[]; oldestTradeId: string | null }> {
  const raw = await fetchTrades(mint, { beforeId: opts.beforeId, limit: opts.limit ?? 500 });
  if (!raw.length) return { candles: [], oldestTradeId: null };
  const stream = (await fetchStreamState(mint)) ?? {
    mint,
    epoch: 1,
    lastTradeId: 0n,
    lastSeq: 0,
    graduationAt: null,
    regime: "bonding_curve" as const,
  };
  const quotes = await fetchDexQuotes(mint);
  const committed = buildCommittedBatch(raw, stream, quotes);
  const { replayTrades } = await import("@/lib/chart/data/candleBuilder");
  const candles = replayTrades(tf, committed).getCandlesSorted();
  return { candles, oldestTradeId: raw[0]?.tradeId ?? null };
}
