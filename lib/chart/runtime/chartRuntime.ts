import "server-only";
import { BoundedMap, BoundedSet } from "@/lib/shared/bounded-map";

import type { ChartTimeframe, CommitBundle, SyncSnapshot, Candle, PriceRegime } from "@/lib/chart/types";
import { DEFAULT_CHART_TF, CHECKPOINT_CANDLE_COUNT, CHECKPOINT_TRADE_INTERVAL, PUMP_SUPPLY, TF_MS } from "@/lib/chart/constants";
import { CommitPipeline } from "@/lib/chart/realtime/commitPipeline";
import { ChartMintCache } from "@/lib/chart/data/chartCache";
import { MultiTfAggregator, replayTrades } from "@/lib/chart/data/candleBuilder";
import { fetchGeckoOhlcv } from "@/lib/chart/data/geckoOhlcv";
import { resolveDexPool } from "@/lib/dex/dex-pool";
import { resolveGraduationMs } from "@/lib/chart/data/graduation";
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
// Bounded: both grew one entry per mint for the worker's lifetime.
//
// BOUNDED SEMANTICS — what eviction can and cannot cost.
// Both are chart-stream bookkeeping only. `epochBumpedMints` is a once-per-boot
// dedup marker for the epoch bump below; `tradeCounters` paces checkpoint
// writes. Past CHART_MINT_MAX distinct mints in one worker lifetime the oldest
// markers are evicted, so a long-idle mint that becomes active again can be
// epoch-bumped a second time, or have its checkpoint counter restart.
//
// Blast radius is one chart resync: `epoch` is written only to
// chart_stream_state / chart_candle_checkpoints and read only by the chart
// client's monotonic (epoch, lastTradeId) check, which treats a newer epoch as
// an authoritative reset. Nothing in the trade path, position state, safety
// controls, PnL or ingestion reads it — grep `epoch` outside lib/chart/ returns
// only the schema definitions. A redundant bump therefore costs a snapshot
// refetch for viewers of that one chart, never a trading decision.
const CHART_MINT_MAX = 5_000;
const tradeCounters = new BoundedMap<string, number>(CHART_MINT_MAX);
const epochBumpedMints = new BoundedSet<string>(CHART_MINT_MAX);

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

function mcapOf(candles: Candle[]): number {
  const last = candles[candles.length - 1];
  return last ? last.close * PUMP_SUPPLY : 0;
}

// Bonding-curve candles are static history once a token graduates, so cache them
// per mint+tf. Built from DB trades deterministically so every endpoint returns
// identical data. Returns ALL curve candles; the caller trims to the period
// before Gecko's earliest candle.
// Bounded: candle arrays per (mint,timeframe), previously never evicted.
const curveCandlesCache = new BoundedMap<string, Candle[]>(500);

async function getCurveCandlesCached(
  mint: string,
  tf: ChartTimeframe,
  stream: StreamStateRow,
): Promise<Candle[]> {
  const key = `${mint}:${tf}`;
  const cached = curveCandlesCache.get(key);
  if (cached) return cached;

  const raw = await fetchTrades(mint, { limit: 2000 });
  if (!raw.length) {
    curveCandlesCache.set(key, []);
    return [];
  }
  const quotes = await fetchDexQuotes(mint);
  const committed = buildCommittedBatch(raw, stream, quotes);
  const all = replayTrades(tf, committed).getCandlesSorted();
  curveCandlesCache.set(key, all);
  return all;
}

async function hydrateGraduatedCandles(
  mint: string,
  tf: ChartTimeframe,
  curveCandles: Candle[],
  stream: StreamStateRow,
): Promise<{ candles: Candle[]; marketCap: number; regime: PriceRegime; graduationMs: number | null }> {
  const graduationMs = await resolveGraduationMs(mint, stream);
  const graduated = stream.regime === "dex" || graduationMs != null;

  // Pre-graduation: bonding-curve candles are built from real on-chain trades and
  // are already dense — leave them as-is.
  if (!graduated) {
    return { candles: curveCandles, marketCap: mcapOf(curveCandles), regime: stream.regime, graduationMs };
  }

  const regime: PriceRegime = "dex";

  // ── Primary DEX source: real OHLCV from GeckoTerminal (dense, like DexScreener) ──
  const pool = await resolveDexPool(mint);
  if (pool) {
    let dexCandles = await fetchGeckoOhlcv(pool, tf);
    if (dexCandles.length) {
      // ── A2: real-time tail ──────────────────────────────────────────────────
      // Overlay the fast on-chain quote candles (chart-onchain-quote-lane, ~2s)
      // onto Gecko's recent buckets. Gecko stays the finalized history; on-chain
      // wins for the buckets it covers, so the forming candle + live mcap update
      // in ~2s instead of waiting ~20s for Gecko's cache. On-chain quotes only
      // exist for the chart being viewed, so this is targeted and cheap.
      try {
        const onchainQuotes = (await fetchDexQuotes(mint, 400)).filter((q) => q.source === "onchain");
        if (onchainQuotes.length) {
          const { quotesToCandles } = await import("@/lib/chart/data/dexCandles");
          const ocCandles = quotesToCandles(tf, onchainQuotes);
          if (ocCandles.length) {
            const byTime = new Map<number, Candle>(dexCandles.map((c) => [c.time, c]));
            for (const oc of ocCandles) byTime.set(oc.time, oc);
            dexCandles = [...byTime.values()].sort((a, b) => a.time - b.time);
          }
        }
      } catch {
        /* on-chain overlay is best-effort — fall back to pure Gecko */
      }
      // Gecko data is ALL post-migration DEX activity (the pool only exists after
      // migration), so we never filter it by the unreliable graduation timestamp —
      // doing so dropped most Gecko candles and left only sparse curve dashes.
      // Instead, the migration boundary is Gecko's earliest candle, and the
      // bonding-curve history fills only the period before it. Gecko stays the
      // dense tail, so the chart looks like DexScreener and the mcap is consistent.
      const migrationSec = dexCandles[0]!.time;
      // Gecko returns 1-minute candles for sub-minute frames, so build the curve at
      // 1m too (matching granularity) — otherwise 1s curve buckets clash with 1m DEX
      // candles at the boundary.
      const curveTf: ChartTimeframe = tf === "1s" || tf === "5s" || tf === "15s" ? "1m" : tf;
      const preCurveRaw = (await getCurveCandlesCached(mint, curveTf, stream)).filter(
        (c) => c.time < migrationSec,
      );
      let candles = dexCandles;
      // Marker only when we actually stitched curve→DEX (anchored at the curve end).
      // Never use resolveGraduationMs here — it falls back to the latest DEX trade,
      // which lands the marker on the newest candle.
      let gradMs: number | null = null;
      if (preCurveRaw.length) {
        // Curve mcap (bonding-curve formula × current SOL price) and Gecko mcap
        // (DEX price × supply) are different valuation bases, so the curve tail and
        // the DEX head don't line up — a jarring mcap "mismatch" at migration.
        // Normalize the curve segment to connect to Gecko's opening price: this
        // preserves the pre-migration *shape* (the relative pump/dump) while fixing
        // the level. Gecko is never scaled, so the live mcap stays accurate.
        const curveLast = preCurveRaw[preCurveRaw.length - 1]!.close;
        const dexOpen = dexCandles[0]!.open > 0 ? dexCandles[0]!.open : dexCandles[0]!.close;
        const factor = curveLast > 0 && dexOpen > 0 ? dexOpen / curveLast : 1;
        const preCurve =
          factor === 1
            ? preCurveRaw
            : preCurveRaw.map((c) => ({
                ...c,
                open: c.open * factor,
                high: c.high * factor,
                low: c.low * factor,
                close: c.close * factor,
              }));
        candles = [...preCurve, ...dexCandles];
        // The migration happened at the END of the bonding curve (the last curve
        // trade that completed it, ~$40–69k mcap), NOT at Gecko's first returned
        // candle (which for an older coin is just the start of Gecko's recent
        // window). Anchor the marker to the last curve candle so it sits at the
        // real migration point, not the latest candle.
        gradMs = preCurve[preCurve.length - 1]!.time * 1000;
      }
      return { candles, marketCap: mcapOf(dexCandles), regime, graduationMs: gradMs };
    }
  }

  // ── Fallback: quote snapshots (GeckoTerminal unavailable / pool not indexed) ──
  // Read existing quotes only (the quote lane keeps them fresh in the background);
  // both endpoints read the same DB rows, so this stays consistent too.
  const quotes = await fetchDexQuotes(mint);
  if (quotes.length) {
    const { quotesToCandles } = await import("@/lib/chart/data/dexCandles");
    const candles = quotesToCandles(tf, quotes);
    // No stitched curve history in this array → no boundary to anchor a marker to
    // (better no marker than one on the latest candle).
    return { candles, marketCap: mcapOf(candles), regime, graduationMs: null };
  }
  return { candles: curveCandles, marketCap: mcapOf(curveCandles), regime, graduationMs: null };
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
  const ensured = await ensureMint(mint);
  const { agg, tailAfterTradeId } = ensured;
  const stream = await replayTradesIntoAgg(mint, ensured.stream, agg, tailAfterTradeId);
  const curveCandles = agg.aggs[tf].getCandlesSorted().slice(-CHECKPOINT_CANDLE_COUNT);
  const hydrated = await hydrateGraduatedCandles(mint, tf, curveCandles, stream);
  return {
    mint,
    tf,
    epoch: stream.epoch,
    lastTradeId: stream.lastTradeId.toString(),
    candles: hydrated.candles,
    marketCap: hydrated.marketCap,
    regime: hydrated.regime,
    graduationAt: hydrated.graduationMs ?? stream.graduationAt?.getTime() ?? null,
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
): Promise<{
  candles: import("@/lib/chart/types").Candle[];
  oldestTradeId: string | null;
  hasMoreEvents: boolean;
}> {
  const limit = opts.limit ?? 500;
  const raw = await fetchTrades(mint, { beforeId: opts.beforeId, limit });
  const stream = (await fetchStreamState(mint)) ?? {
    mint,
    epoch: 1,
    lastTradeId: 0n,
    lastSeq: 0,
    graduationAt: null,
    regime: "bonding_curve" as const,
  };

  let curveCandles: Candle[] = [];
  if (raw.length) {
    const quotes = await fetchDexQuotes(mint);
    const committed = buildCommittedBatch(raw, stream, quotes);
    const { replayTrades } = await import("@/lib/chart/data/candleBuilder");
    curveCandles = replayTrades(tf, committed).getCandlesSorted();
  }

  const hydrated = await hydrateGraduatedCandles(mint, tf, curveCandles, stream);

  return {
    candles: hydrated.candles,
    oldestTradeId: raw[0]?.tradeId ?? null,
    hasMoreEvents: raw.length >= limit,
  };
}
