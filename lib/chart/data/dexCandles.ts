import { TF_MS } from "@/lib/chart/constants";
import type { Candle, ChartTimeframe, DexQuoteRow } from "@/lib/chart/types";

function bucketMs(tsMs: number, tf: ChartTimeframe): number {
  return Math.floor(tsMs / TF_MS[tf]) * TF_MS[tf];
}

function toChartTime(bucketMs: number): number {
  return Math.floor(bucketMs / 1000);
}

/** Build OHLC buckets from DEX quote snapshots (post-graduation price ticks). */
export function quotesToCandles(
  tf: ChartTimeframe,
  quotes: DexQuoteRow[],
  opts: { afterMs?: number } = {},
): Candle[] {
  const afterMs = opts.afterMs ?? 0;
  const sorted = quotes
    .filter((q) => q.priceUsd > 0 && q.ts.getTime() >= afterMs)
    .sort((a, b) => a.ts.getTime() - b.ts.getTime());
  if (!sorted.length) return [];

  const byBucket = new Map<number, Candle>();
  for (const q of sorted) {
    const bMs = bucketMs(q.ts.getTime(), tf);
    const p = q.priceUsd;
    const existing = byBucket.get(bMs);
    if (!existing) {
      byBucket.set(bMs, {
        time: toChartTime(bMs),
        open: p,
        high: p,
        low: p,
        close: p,
        volume: 0,
        state: "open",
      });
      continue;
    }
    existing.high = Math.max(existing.high, p);
    existing.low = Math.min(existing.low, p);
    existing.close = p;
  }
  const candles = [...byBucket.values()].sort((a, b) => a.time - b.time);

  // Connect candle opens to the previous candle's close.
  // DEX poll data has open=close per bucket (single price snapshot). Setting
  // open = prev.close creates real directional bodies (green/red) whenever price
  // moved between polls — the same convention used by most professional charts
  // for snapshot-based data. High/low are widened to always contain both ends.
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1]!;
    const curr = candles[i]!;
    curr.open = prev.close;
    if (curr.open > curr.high) curr.high = curr.open;
    if (curr.open < curr.low) curr.low = curr.open;
  }

  // Any remaining flat doji (first candle, or two consecutive identical prices)
  // gets a ±0.5% synthetic wick so at least the wick lines are visible.
  for (const c of candles) {
    if (c.high === c.low && c.high > 0) {
      const half = c.close * 0.005;
      c.high = c.close + half;
      c.low = c.close - half;
    }
  }
  return candles;
}

/**
 * Merge bonding-curve candles with DEX quote candles at graduation.
 * First post-grad open is pinned to the last pre-grad close for continuity.
 */
export function stitchCurveAndDex(
  curve: Candle[],
  dex: Candle[],
  graduationMs: number,
  tf: ChartTimeframe,
): Candle[] {
  if (!dex.length) return curve;
  const gradBucketMs = bucketMs(graduationMs, tf);
  const gradTime = toChartTime(gradBucketMs);

  const pre = curve.filter((c) => c.time < gradTime);
  const post = dex.filter((c) => c.time >= gradTime);

  if (!post.length) return curve;

  const lastPre = pre.length ? pre[pre.length - 1]! : null;
  if (lastPre) {
    const first = post[0]!;
    const anchor = lastPre.close;
    first.open = anchor;
    first.high = Math.max(first.high, anchor);
    first.low = Math.min(first.low, anchor);
  }

  const map = new Map<number, Candle>();
  for (const c of pre) map.set(c.time, c);
  for (const c of post) map.set(c.time, c);
  return [...map.values()].sort((a, b) => a.time - b.time);
}

export function mergeGraduatedCandles(
  tf: ChartTimeframe,
  curve: Candle[],
  quotes: DexQuoteRow[],
  graduationMs: number | null,
): Candle[] {
  if (graduationMs == null || !quotes.length) return curve;
  // When there is no bonding-curve history the graduation anchor (often derived
  // from coin.lastTradeAt rather than the real migration time) would filter out
  // all earlier DEX quotes. Skip the filter and return all available quotes.
  if (!curve.length) return quotesToCandles(tf, quotes);
  const dex = quotesToCandles(tf, quotes, { afterMs: graduationMs });
  if (!dex.length) return curve;
  return stitchCurveAndDex(curve, dex, graduationMs, tf);
}
