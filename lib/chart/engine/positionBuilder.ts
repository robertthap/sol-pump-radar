import type { ChartTimeframe, UserTrade } from "@/lib/chart/types";
import { TF_MS } from "@/lib/chart/constants";
import { pnlFromMcap } from "@/lib/paper/mcap-pnl";

export type BuiltPosition = {
  positionId: string;
  buys: UserTrade[];
  sells: UserTrade[];
  realizedPnlPct?: number;
};

/** Group fills by positionId; FIFO when missing. */
export function buildPositions(fills: UserTrade[]): BuiltPosition[] {
  const byPos = new Map<string, UserTrade[]>();
  for (const f of fills) {
    const key = f.positionId || `fifo-${f.wallet}`;
    const arr = byPos.get(key) ?? [];
    arr.push(f);
    byPos.set(key, arr);
  }
  const out: BuiltPosition[] = [];
  for (const [positionId, rows] of byPos) {
    const sorted = rows.sort((a, b) => {
      const ai = BigInt(a.tradeId ?? "0");
      const bi = BigInt(b.tradeId ?? "0");
      if (ai < bi) return -1;
      if (ai > bi) return 1;
      return a.timestamp - b.timestamp;
    });
    const buys = sorted.filter((x) => x.side === "buy");
    const sells = sorted.filter((x) => x.side === "sell");
    let realizedPnlPct: number | undefined;
    if (buys.length && sells.length) {
      const entryMcap = buys[0]!.price * 1e9;
      const exitMcap = sells[sells.length - 1]!.price * 1e9;
      const pnl = pnlFromMcap({
        sizeSol: 1,
        entryMcapUsd: entryMcap,
        currentMcapUsd: exitMcap,
        pumpFeesPct: 0,
        paperSlippagePct: 0,
      });
      realizedPnlPct = pnl.pctOfSize;
    }
    out.push({ positionId, buys, sells, realizedPnlPct });
  }
  return out;
}

export function userTradesVersion(fills: UserTrade[]): string {
  const ids = fills
    .map((f) => f.tradeId ?? `${f.txHash}:${f.side}`)
    .sort()
    .join(",");
  let h = 0;
  for (let i = 0; i < ids.length; i++) h = (Math.imul(31, h) + ids.charCodeAt(i)) | 0;
  return String(h);
}

export function bucketForTrade(tsMs: number, tf: ChartTimeframe): number {
  return Math.floor(tsMs / TF_MS[tf]) * TF_MS[tf];
}
