import type { Candle } from "@/lib/chart/types";
import type { ISeriesApi, UTCTimestamp } from "lightweight-charts";
import { CHART_THEME } from "@/components/chart/chartTheme";

export function toLwCandle(c: Candle) {
  return {
    time: c.time as UTCTimestamp,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
  };
}

export function toLwVolume(c: Candle) {
  return {
    time: c.time as UTCTimestamp,
    value: c.volume,
    color: c.close >= c.open ? CHART_THEME.upVol : CHART_THEME.downVol,
  };
}

export function candlesEqual(a: Candle, b: Candle): boolean {
  return (
    a.time === b.time &&
    a.open === b.open &&
    a.high === b.high &&
    a.low === b.low &&
    a.close === b.close &&
    a.volume === b.volume
  );
}

export type ApplyResult = { candles: Candle[]; structural: boolean; firstDiff: number };

/** LWC requires data strictly ascending and unique by time. Upstream merges
 *  normally guarantee this, but sanitize at the rendering boundary so a stray
 *  duplicate or out-of-order candle can never crash setData/update. Fast path
 *  returns the input untouched when it is already clean (the common case). */
function sanitizeAscending(candles: Candle[]): Candle[] {
  let clean = true;
  for (let i = 1; i < candles.length; i++) {
    if (candles[i]!.time <= candles[i - 1]!.time) {
      clean = false;
      break;
    }
  }
  if (clean) return candles;
  const map = new Map<number, Candle>();
  for (const c of candles) map.set(c.time, c); // last write wins per time
  return [...map.values()].sort((a, b) => a.time - b.time);
}

/** Apply candle array with setData/update split for LWC v5.
 *  Returns structural (true = full reset was done) and firstDiff (first index that changed)
 *  so callers can make incremental decisions for derived series (MA, RSI, etc.). */
export function applyCandlesToSeries(
  candleSeries: ISeriesApi<"Candlestick">,
  volumeSeries: ISeriesApi<"Histogram">,
  prev: Candle[],
  nextRaw: Candle[],
  opts: { reset?: boolean },
): ApplyResult {
  const next = sanitizeAscending(nextRaw);
  const isReset = opts.reset || prev.length === 0;

  let firstDiff = 0;
  const min = Math.min(prev.length, next.length);
  while (firstDiff < min && candlesEqual(prev[firstDiff]!, next[firstDiff]!)) firstDiff++;

  // LWC's series.update() may ONLY append (time > last) or replace the last bar
  // (time === last). Handing it an older time throws "Cannot update oldest data".
  // So we take the cheap incremental path ONLY when we can prove the change is a
  // pure tail edit (last bar replaced or new bars appended) with monotonic times.
  // Everything else falls back to setData(), which validates/sorts internally.
  // The caller saves & restores the visible logical range, so setData() does not
  // jump the viewport.
  const seriesLastTime = prev.length ? prev[prev.length - 1]!.time : -Infinity;

  let canIncrement =
    !isReset &&
    next.length >= prev.length &&
    // shared prefix must reach the last existing bar: only the last bar changed
    // (firstDiff === prev.length-1) or bars were purely appended (=== prev.length).
    firstDiff >= prev.length - 1 &&
    // no prepend / re-anchor of the first bar
    (!prev[0] || !next[0] || next[0].time === prev[0].time);

  if (canIncrement && firstDiff < next.length) {
    // Verify every bar we would write is monotonic against the series tail.
    let lastT = seriesLastTime;
    for (let k = firstDiff; k < next.length; k++) {
      const t = next[k]!.time;
      if (k === firstDiff && firstDiff < prev.length) {
        // replacing the existing last bar — time must match it exactly
        if (t !== prev[firstDiff]!.time) {
          canIncrement = false;
          break;
        }
      } else if (t <= lastT) {
        // appended bars must be strictly increasing and newer than the tail
        canIncrement = false;
        break;
      }
      lastT = t;
    }
  }

  if (!canIncrement) {
    candleSeries.setData(next.map(toLwCandle));
    volumeSeries.setData(next.map(toLwVolume));
    return { candles: next, structural: true, firstDiff };
  }

  for (let k = firstDiff; k < next.length; k++) {
    candleSeries.update(toLwCandle(next[k]!));
    volumeSeries.update(toLwVolume(next[k]!));
  }
  return { candles: next, structural: false, firstDiff };
}
