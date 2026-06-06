import type { Candle, ChartTimeframe, CommitBundle, CommittedTrade } from "@/lib/chart/types";
import {
  TAIL_REPLAY_MAX_MS,
  TAIL_REPLAY_MAX_TRADES,
  RECONCILE_CPU_BUDGET_MS,
} from "@/lib/chart/constants";
import { replayTrades } from "@/lib/chart/data/candleBuilder";
import { commitTrade } from "@/lib/chart/data/priceResolver";
import type { RawTradeInput } from "@/lib/chart/data/priceResolver";
import type { DexQuoteRow, StreamStateRow } from "@/lib/chart/types";

export function checksumCandles(candles: Candle[], n = 10): string {
  const finals = candles
    .filter((c) => c.state === "final" || c.state === "soft")
    .sort((a, b) => a.time - b.time)
    .slice(-n);
  return finals.map((c) => `${c.time}:${c.close.toFixed(8)}`).join("|");
}

export function buildCommittedBatch(
  raw: RawTradeInput[],
  stream: StreamStateRow,
  quotes: DexQuoteRow[],
): CommittedTrade[] {
  const sorted = raw
    .slice()
    .sort((a, b) => {
      const ai = BigInt(a.tradeId);
      const bi = BigInt(b.tradeId);
      return ai < bi ? -1 : ai > bi ? 1 : 0;
    });
  const ctx: Pick<StreamStateRow, "graduationAt" | "regime"> = {
    graduationAt: stream.graduationAt,
    regime: stream.regime,
  };
  const out: CommittedTrade[] = [];
  for (const r of sorted) {
    const t = commitTrade(r, ctx, quotes);
    out.push(t);
    if (t.regime === "dex" && ctx.regime === "bonding_curve") {
      ctx.regime = "dex";
      ctx.graduationAt = ctx.graduationAt ?? new Date(r.timestamp);
    }
  }
  return out;
}

export function windowReplay(
  tf: ChartTimeframe,
  trades: CommittedTrade[],
): Candle[] {
  if (!trades.length) return [];
  const now = Date.now();
  const minTs = now - TAIL_REPLAY_MAX_MS;
  const capped = trades.slice(-TAIL_REPLAY_MAX_TRADES).filter((t) => t.timestamp >= minTs);
  return replayTrades(tf, capped).getCandlesSorted();
}

export function detectDrift(live: Candle[], replayed: Candle[]): boolean {
  if (!live.length || !replayed.length) return false;
  return checksumCandles(live) !== checksumCandles(replayed);
}

export type ReconcileResult = {
  patches: CommitBundle["candlePatches"];
  drift: boolean;
  replayedCount: number;
  deferred: boolean;
};

export function reconcileWindow(opts: {
  tf: ChartTimeframe;
  liveCandles: Candle[];
  rawTrades: RawTradeInput[];
  stream: StreamStateRow;
  quotes: DexQuoteRow[];
  startedAt?: number;
}): ReconcileResult {
  const started = opts.startedAt ?? Date.now();
  const committed = buildCommittedBatch(opts.rawTrades, opts.stream, opts.quotes);
  if (Date.now() - started > RECONCILE_CPU_BUDGET_MS) {
    return { patches: [], drift: false, replayedCount: 0, deferred: true };
  }
  const replayed = windowReplay(opts.tf, committed);
  const drift = detectDrift(opts.liveCandles, replayed);
  const patches: CommitBundle["candlePatches"] = [];
  if (drift) {
    for (const c of replayed.slice(-20)) {
      patches.push({
        tf: opts.tf,
        bucketTime: c.time * 1000,
        candle: c,
        kind: "correction",
      });
    }
  }
  return { patches, drift, replayedCount: committed.length, deferred: false };
}

export function mergeOverlapCandles(a: Candle[], b: Candle[]): Candle[] {
  const map = new Map<number, Candle>();
  for (const c of a) map.set(c.time, c);
  for (const c of b) map.set(c.time, c);
  return [...map.values()].sort((x, y) => x.time - y.time);
}
