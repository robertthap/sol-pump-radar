import type { ChartMarkerInstance, ChartTimeframe, UserTrade } from "@/lib/chart/types";
import { bucketForTrade, buildPositions } from "@/lib/chart/engine/positionBuilder";

const MAX_LANES = 4;

export function markerId(positionId: string, tradeId: string, side: string): string {
  return `${positionId}:${tradeId}:${side}`;
}

/** Snap trade to candle bucket start (unix seconds) for the active TF. */
export function anchorTimeForTrade(timestampMs: number, tf: ChartTimeframe): number {
  return Math.floor(bucketForTrade(timestampMs, tf) / 1000);
}

export function buildMarkers(fills: UserTrade[], tf: ChartTimeframe): Map<string, ChartMarkerInstance> {
  const positions = buildPositions(fills);
  const flat: Array<UserTrade & { positionId: string; pnl?: number }> = [];
  for (const p of positions) {
    for (const b of p.buys) flat.push({ ...b, positionId: p.positionId });
    for (const s of p.sells) {
      flat.push({ ...s, positionId: p.positionId, pnl: p.realizedPnlPct });
    }
  }
  flat.sort((a, b) => {
    if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
    const ai = BigInt(a.tradeId ?? "0");
    const bi = BigInt(b.tradeId ?? "0");
    if (ai < bi) return -1;
    if (ai > bi) return 1;
    return a.side.localeCompare(b.side);
  });

  const laneAtTime = new Map<number, number>();
  const out = new Map<string, ChartMarkerInstance>();

  for (const t of flat) {
    const anchorTime = anchorTimeForTrade(t.timestamp, tf);
    const bucketTime = bucketForTrade(t.timestamp, tf);
    const laneKey = bucketTime;
    const lane = Math.min(laneAtTime.get(laneKey) ?? 0, MAX_LANES - 1);
    laneAtTime.set(laneKey, lane + 1);
    const id = markerId(t.positionId, t.tradeId ?? t.txHash, t.side);
    out.set(id, {
      id,
      tradeId: t.tradeId ?? t.txHash,
      bucketTime,
      anchorTime,
      side: t.side,
      price: t.price,
      amount: t.amount,
      lane,
      pnl: t.pnl,
    });
  }
  return out;
}

export function findMarkerAtCrosshair(
  markers: Map<string, ChartMarkerInstance>,
  timeSec: number,
  tf: ChartTimeframe,
): ChartMarkerInstance | null {
  const bucketMs = bucketForTrade(timeSec * 1000, tf);
  let best: ChartMarkerInstance | null = null;
  for (const m of markers.values()) {
    if (m.bucketTime !== bucketMs) continue;
    if (!best || Math.abs(m.anchorTime - timeSec) < Math.abs(best.anchorTime - timeSec)) {
      best = m;
    }
  }
  return best;
}
