import { mcapUsdFromVSol } from "@/lib/dex/curve-mcap";
import { PUMP_SUPPLY, DEX_QUOTE_LOOKBACK_MS } from "@/lib/chart/constants";
import { marketCapFromPrice, unitPriceFromMcap } from "@/lib/chart/data/marketCap";
import type { CommittedTrade, DexQuoteRow, PriceRegime, StreamStateRow, Trade } from "@/lib/chart/types";

export type RawTradeInput = {
  token: string;
  wallet: string;
  side: "buy" | "sell";
  amount: number;
  timestamp: number;
  txHash: string;
  tradeId: string;
  vSolAfter: number | null;
};

export function bondingCurveUnitPrice(vSol: number | null | undefined): number {
  if (vSol == null || !Number.isFinite(vSol) || vSol <= 0) return 0;
  const mcap = mcapUsdFromVSol(vSol);
  if (mcap == null || mcap <= 0) return 0;
  return unitPriceFromMcap(mcap);
}

export function nearestDexQuote(
  quotes: DexQuoteRow[],
  tradeTsMs: number,
): DexQuoteRow | null {
  if (!quotes.length) return null;
  let best: DexQuoteRow | null = null;
  let bestDelta = Infinity;
  for (const q of quotes) {
    const qMs = q.ts.getTime();
    if (qMs > tradeTsMs) continue;
    const delta = tradeTsMs - qMs;
    if (delta <= DEX_QUOTE_LOOKBACK_MS && delta < bestDelta) {
      best = q;
      bestDelta = delta;
    }
  }
  if (best) return best;
  // fallback: last quote before trade (playbook: else last quote before trade)
  for (let i = quotes.length - 1; i >= 0; i--) {
    const q = quotes[i]!;
    if (q.ts.getTime() <= tradeTsMs) return q;
  }
  return quotes[quotes.length - 1] ?? null;
}

export function regimeForTrade(
  stream: Pick<StreamStateRow, "graduationAt" | "regime">,
  tradeTsMs: number,
): PriceRegime {
  if (stream.graduationAt == null) return "bonding_curve";
  return tradeTsMs >= stream.graduationAt.getTime() ? "dex" : "bonding_curve";
}

export function resolveUnitPrice(
  raw: RawTradeInput,
  stream: Pick<StreamStateRow, "graduationAt" | "regime">,
  dexQuotes: DexQuoteRow[],
): { price: number; regime: PriceRegime } {
  const regime = regimeForTrade(stream, raw.timestamp);
  if (regime === "bonding_curve") {
    return { price: bondingCurveUnitPrice(raw.vSolAfter), regime };
  }
  const quote = nearestDexQuote(dexQuotes, raw.timestamp);
  if (quote && quote.priceUsd > 0) {
    return { price: quote.priceUsd, regime: "dex" };
  }
  // graduated but no quote yet — use frozen curve as last resort for continuity
  const fallback = bondingCurveUnitPrice(raw.vSolAfter);
  return { price: fallback, regime: "dex" };
}

export function commitTrade(
  raw: RawTradeInput,
  stream: Pick<StreamStateRow, "graduationAt" | "regime">,
  dexQuotes: DexQuoteRow[],
  committedAt = Date.now(),
): CommittedTrade {
  const { price, regime } = resolveUnitPrice(raw, stream, dexQuotes);
  const base: Trade = {
    token: raw.token,
    wallet: raw.wallet,
    side: raw.side,
    price,
    amount: raw.amount,
    timestamp: raw.timestamp,
    txHash: raw.txHash,
    tradeId: raw.tradeId,
  };
  return {
    ...base,
    regime,
    marketCap: marketCapFromPrice(price),
    committedAt,
  };
}
