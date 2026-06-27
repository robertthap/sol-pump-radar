import type { Candle } from "@/lib/chart/types";

export type LinePoint = { time: number; value: number };

export function sma(candles: Candle[], period: number): LinePoint[] {
  if (period < 1 || candles.length < period) return [];
  const out: LinePoint[] = [];
  let sum = 0;
  for (let i = 0; i < candles.length; i++) {
    sum += candles[i]!.close;
    if (i >= period) sum -= candles[i - period]!.close;
    if (i >= period - 1) {
      out.push({ time: candles[i]!.time, value: sum / period });
    }
  }
  return out;
}

export function ema(candles: Candle[], period: number): LinePoint[] {
  if (period < 1 || !candles.length) return [];
  const k = 2 / (period + 1);
  const out: LinePoint[] = [];
  let prev = candles[0]!.close;
  out.push({ time: candles[0]!.time, value: prev });
  for (let i = 1; i < candles.length; i++) {
    const v = candles[i]!.close * k + prev * (1 - k);
    out.push({ time: candles[i]!.time, value: v });
    prev = v;
  }
  return out;
}

/** RSI(14) on close; values 0–100. */
export function rsi(candles: Candle[], period = 14): LinePoint[] {
  if (candles.length <= period) return [];
  const out: LinePoint[] = [];
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = candles[i]!.close - candles[i - 1]!.close;
    if (d >= 0) avgGain += d;
    else avgLoss -= d;
  }
  avgGain /= period;
  avgLoss /= period;
  const rs0 = avgLoss === 0 ? 100 : avgGain / avgLoss;
  out.push({ time: candles[period]!.time, value: 100 - 100 / (1 + rs0) });
  for (let i = period + 1; i < candles.length; i++) {
    const d = candles[i]!.close - candles[i - 1]!.close;
    const gain = d > 0 ? d : 0;
    const loss = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    out.push({ time: candles[i]!.time, value: 100 - 100 / (1 + rs) });
  }
  return out;
}

export function pctChange(from: number, to: number): number | null {
  if (!Number.isFinite(from) || from === 0 || !Number.isFinite(to)) return null;
  return (to - from) / from;
}
