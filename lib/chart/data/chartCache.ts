import type { Candle, ChartTimeframe, CommitBundle, StreamStateRow } from "@/lib/chart/types";
import { CHECKPOINT_CANDLE_COUNT, MAX_WARM_MINTS } from "@/lib/chart/constants";
import type { MultiTfAggregator } from "@/lib/chart/data/candleBuilder";

type MintEntry = {
  mint: string;
  aggregator: MultiTfAggregator;
  stream: StreamStateRow;
  subscribed: boolean;
  lastActivityMs: number;
  tradesSinceCheckpoint: number;
};

export class ChartMintCache {
  private readonly entries = new Map<string, MintEntry>();
  private readonly subscribers = new Set<string>();

  markSubscribed(mint: string, on: boolean): void {
    if (on) this.subscribers.add(mint);
    else this.subscribers.delete(mint);
    const e = this.entries.get(mint);
    if (e) e.subscribed = on;
  }

  isSubscribed(mint: string): boolean {
    return this.subscribers.has(mint);
  }

  getOrCreate(
    mint: string,
    stream: StreamStateRow,
    aggregator: MultiTfAggregator,
  ): MintEntry {
    let e = this.entries.get(mint);
    if (!e) {
      e = {
        mint,
        aggregator,
        stream,
        subscribed: this.subscribers.has(mint),
        lastActivityMs: Date.now(),
        tradesSinceCheckpoint: 0,
      };
      this.entries.set(mint, e);
      this.evictIfNeeded();
    }
    return e;
  }

  touch(mint: string, tradeCount = 1): void {
    const e = this.entries.get(mint);
    if (!e) return;
    e.lastActivityMs = Date.now();
    e.tradesSinceCheckpoint += tradeCount;
  }

  get(mint: string): MintEntry | undefined {
    return this.entries.get(mint);
  }

  getTailCandles(mint: string, tf: ChartTimeframe): Candle[] {
    const e = this.entries.get(mint);
    if (!e) return [];
    return e.aggregator.aggs[tf].getCandlesSorted().slice(-CHECKPOINT_CANDLE_COUNT);
  }

  private evictIfNeeded(): void {
    const now = Date.now();
    const warm = [...this.entries.values()].filter((e) => !e.subscribed);
    if (warm.length <= MAX_WARM_MINTS) return;

    warm.sort((a, b) => a.lastActivityMs - b.lastActivityMs);
    while (warm.length > MAX_WARM_MINTS) {
      const victim = warm.shift();
      if (!victim || victim.subscribed) continue;
      if (now - victim.lastActivityMs < 10 * 60_000) continue;
      this.entries.delete(victim.mint);
    }
  }

  /** Returns evicted mints that need persist-before-drop. */
  evictCold(nowMs = Date.now()): string[] {
    const out: string[] = [];
    for (const [mint, e] of this.entries) {
      if (e.subscribed) continue;
      if (nowMs - e.lastActivityMs > 10 * 60_000) {
        out.push(mint);
        this.entries.delete(mint);
      }
    }
    return out;
  }
}

export function mergeCandlePages(existing: Candle[], older: Candle[]): Candle[] {
  const map = new Map<number, Candle>();
  for (const c of older) map.set(c.time, c);
  for (const c of existing) map.set(c.time, c);
  return [...map.values()].sort((a, b) => a.time - b.time);
}

/** Keep REST scroll-back history; refresh overlapping tail from WS snapshot. */
export function mergeSnapshotTail(existing: Candle[], snap: Candle[]): Candle[] {
  if (!snap.length) return existing;
  if (!existing.length) return snap;
  const snapStart = snap[0]!.time;
  const older = existing.filter((c) => c.time < snapStart);
  return mergeCandlePages(snap, older);
}

export function dedupeBundlesByTradeId(bundles: CommitBundle[]): CommitBundle[] {
  const seen = new Set<string>();
  const out: CommitBundle[] = [];
  for (const b of bundles) {
    if (seen.has(b.lastTradeId)) continue;
    seen.add(b.lastTradeId);
    out.push(b);
  }
  return out.sort((a, b) => {
    const ai = BigInt(a.lastTradeId);
    const bi = BigInt(b.lastTradeId);
    return ai < bi ? -1 : ai > bi ? 1 : 0;
  });
}
