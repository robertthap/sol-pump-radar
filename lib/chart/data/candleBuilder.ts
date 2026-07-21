import { SOFT_BUCKETS, TF_MS, CHART_TIMEFRAMES } from "@/lib/chart/constants";
import type {
  Candle,
  CandlePatch,
  CandlePatchKind,
  CandleState,
  ChartTimeframe,
  CommittedTrade,
} from "@/lib/chart/types";

function bucketTime(timestampMs: number, tf: ChartTimeframe): number {
  const tfMs = TF_MS[tf];
  return Math.floor(timestampMs / tfMs) * tfMs;
}

function toChartTime(bucketMs: number): number {
  return Math.floor(bucketMs / 1000);
}

function newCandle(bucketMs: number, price: number, volume: number, state: CandleState): Candle {
  return {
    time: toChartTime(bucketMs),
    open: price,
    high: price,
    low: price,
    close: price,
    volume,
    state,
  };
}

function mutateInPlace(candle: Candle, trade: CommittedTrade): void {
  const p = trade.price;
  if (p > 0) {
    candle.high = Math.max(candle.high, p);
    candle.low = candle.low > 0 ? Math.min(candle.low, p) : p;
    candle.close = p;
  }
  candle.volume += trade.amount;
}

function reopen(candle: Candle, trade: CommittedTrade): void {
  candle.state = candle.state === "final" ? "soft" : candle.state;
  mutateInPlace(candle, trade);
}

export class CandleAggregator {
  readonly tf: ChartTimeframe;
  readonly completed = new Map<number, Candle>();
  current: Candle | null = null;
  currentBucketMs: number | null = null;
  private readonly lateToFinal: CommittedTrade[] = [];

  constructor(tf: ChartTimeframe) {
    this.tf = tf;
  }

  /** Trades sorted by tradeId ascending before calling. */
  applyTrade(trade: CommittedTrade): CandlePatch | null {
    const tfMs = TF_MS[this.tf];
    const bucketMs = bucketTime(trade.timestamp, this.tf);

    if (this.currentBucketMs === bucketMs && this.current) {
      mutateInPlace(this.current, trade);
      return this.patch("update", bucketMs, this.current);
    }

    const existing = this.completed.get(bucketMs);
    if (existing && existing.state !== "final") {
      reopen(existing, trade);
      return this.patch("correction", bucketMs, existing);
    }
    if (existing) {
      this.lateToFinal.push(trade);
      return null;
    }

    this.rollForward(bucketMs, trade);
    return this.patch("update", bucketMs, this.current!);
  }

  applyBatch(trades: CommittedTrade[]): CandlePatch[] {
    const patches: CandlePatch[] = [];
    const seen = new Set<number>();
    for (const t of trades) {
      const p = this.applyTrade(t);
      if (p && !seen.has(p.bucketTime)) {
        patches.push(p);
        seen.add(p.bucketTime);
      } else if (p) {
        const idx = patches.findIndex((x) => x.bucketTime === p.bucketTime);
        if (idx >= 0) patches[idx] = p;
      }
    }
    this.ageOutSoftBuckets();
    return patches;
  }

  drainLateToFinal(): CommittedTrade[] {
    const out = [...this.lateToFinal];
    this.lateToFinal.length = 0;
    return out;
  }

  ageOutSoftBuckets(nowMs = Date.now()): void {
    const tfMs = TF_MS[this.tf];
    const softCount = SOFT_BUCKETS[this.tf];
    const softCutoff = nowMs - softCount * tfMs;

    for (const [bucketMs, candle] of this.completed) {
      if (candle.state === "final") continue;
      if (bucketMs < softCutoff) {
        candle.state = "final";
      }
    }
  }

  rollForward(bucketMs: number, trade: CommittedTrade): void {
    const prevClose = this.current?.close ?? null;
    if (this.current && this.currentBucketMs != null) {
      this.current.state = "soft";
      this.completed.set(this.currentBucketMs, { ...this.current });
    }
    this.currentBucketMs = bucketMs;
    // Open at the previous candle's close so single-trade buckets render as real
    // bodies (DexScreener-style) instead of flat doji "dashes". The trade price
    // then sets the close, and high/low span open→price.
    const open = prevClose != null && prevClose > 0 ? prevClose : trade.price;
    const candle = newCandle(bucketMs, open, trade.amount, "open");
    if (trade.price > 0) {
      candle.close = trade.price;
      candle.high = Math.max(open, trade.price);
      candle.low = Math.min(open, trade.price);
    }
    this.current = candle;
  }

  getCandlesSorted(): Candle[] {
    const rows: Candle[] = [...this.completed.values()];
    if (this.current) rows.push(this.current);
    rows.sort((a, b) => a.time - b.time);
    return rows;
  }

  loadCandles(candles: Candle[]): void {
    this.completed.clear();
    this.current = null;
    this.currentBucketMs = null;
    if (!candles.length) return;
    const sorted = [...candles].sort((a, b) => a.time - b.time);
    for (let i = 0; i < sorted.length - 1; i++) {
      const c = sorted[i]!;
      const ms = c.time * 1000;
      this.completed.set(ms, { ...c });
    }
    const last = sorted[sorted.length - 1]!;
    this.currentBucketMs = last.time * 1000;
    this.current = { ...last };
  }

  checksumLastCloses(n = 10): string {
    const finals = [...this.completed.values()]
      .filter((c) => c.state === "final")
      .sort((a, b) => a.time - b.time)
      .slice(-n);
    return finals.map((c) => `${c.time}:${c.close.toFixed(8)}`).join("|");
  }

  private patch(kind: CandlePatchKind, bucketMs: number, candle: Candle): CandlePatch {
    return {
      tf: this.tf,
      bucketTime: bucketMs,
      candle: { ...candle },
      kind,
    };
  }
}

export class MultiTfAggregator {
  readonly aggs = Object.fromEntries(
    CHART_TIMEFRAMES.map((tf) => [tf, new CandleAggregator(tf)]),
  ) as Record<ChartTimeframe, CandleAggregator>;

  applyBatch(trades: CommittedTrade[]): CandlePatch[] {
    const all: CandlePatch[] = [];
    for (const tf of CHART_TIMEFRAMES) {
      all.push(...this.aggs[tf].applyBatch(trades));
    }
    return all;
  }

  drainLateToFinal(): CommittedTrade[] {
    const out: CommittedTrade[] = [];
    for (const tf of CHART_TIMEFRAMES) {
      out.push(...this.aggs[tf].drainLateToFinal());
    }
    return out;
  }
}

export function replayTrades(tf: ChartTimeframe, trades: CommittedTrade[]): CandleAggregator {
  const agg = new CandleAggregator(tf);
  agg.applyBatch(trades);
  return agg;
}
