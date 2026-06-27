"use client";

/**
 * Buy/sell marker model. Trades are bucketed + laned by the marker engine, then
 * snapped to the nearest candle time so native LWC series markers (rendered in
 * TradingChart via createSeriesMarkers) line up exactly with a bar.
 */

import type { UTCTimestamp } from "lightweight-charts";
import type { Candle, ChartTimeframe, UserTrade } from "@/lib/chart/types";
import { buildMarkers } from "@/lib/chart/engine/markerEngine";

export type BsMarker = {
  time: UTCTimestamp;
  price: number;
  side: "buy" | "sell";
  lane: number;
  candleHigh: number;
  candleLow: number;
};

export function snapCandleTime(candles: Candle[], anchorSec: number): number {
  if (!candles.length) return anchorSec;
  let best = candles[0]!.time;
  let dist = Math.abs(best - anchorSec);
  for (const c of candles) {
    const d = Math.abs(c.time - anchorSec);
    if (d < dist) {
      dist = d;
      best = c.time;
    }
  }
  return best;
}

export function candleAtTime(candles: Candle[], timeSec: number): Candle | null {
  for (const c of candles) {
    if (c.time === timeSec) return c;
  }
  return null;
}

export function tradesToBsMarkers(
  trades: UserTrade[],
  tf: ChartTimeframe,
  candles: Candle[] = [],
): BsMarker[] {
  const built = buildMarkers(trades, tf);
  return [...built.values()].map((m) => {
    const snapped = snapCandleTime(candles, m.anchorTime);
    const bar = candleAtTime(candles, snapped);
    return {
      time: snapped as UTCTimestamp,
      price: m.price,
      side: m.side,
      lane: m.lane,
      candleHigh: bar?.high ?? m.price,
      candleLow: bar?.low ?? m.price,
    };
  });
}
