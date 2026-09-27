import exitRecord from "./exit-candidate.json";
import { CURVE_LADDER } from "../trade/curve-ladder";
import { PROGRESS_SOL } from "./catalog";
import { beforeTime, spot, type Trade } from "./pool";

export const EXIT_TAU = exitRecord.candidate.tau;
export const DURATION_BUCKETS = [0, 2, 5, 10, 20, 40, 80, 160];

export function crossingFeatures(tape: Trade[], i: number, target?: string) {
  const t = tape[i], now = beforeTime(tape, t.ts), past = beforeTime(tape, t.ts - 120);
  const buyers = new Map<string, number>();
  let total = 0, unknown = false;
  for (let j = now; j >= 0 && tape[j].ts >= t.ts - 30; j--) {
    const row = tape[j];
    if (row.wallet === target) continue;
    if (!row.state) unknown = true;
    if (row.side !== "buy") continue;
    if (!row.wallet) { unknown = true; continue; }
    buyers.set(row.wallet, (buyers.get(row.wallet) ?? 0) + row.sol);
    total += row.sol;
  }
  // All features except the crossing trade's own size are strictly before t.
  const rate = tape[now]?.state && tape[past]?.state
    ? (tape[now].state!.x - tape[past].state!.x) / PROGRESS_SOL / 120 : null;
  const features = {
    crossing_trade_sol: t.sol,
    buyer_concentration_30s: total > 0 && !unknown ? Math.max(...buyers.values()) / total : null,
    curve_progress_rate_120s: rate,
  };
  const checks = {
    "Crossing ≤ 2.93369 SOL": t.sol <= CURVE_LADDER.maxCrossingTradeSol,
    "Buyer share ≤ 32.04%": features.buyer_concentration_30s == null ? null : features.buyer_concentration_30s <= CURVE_LADDER.maxBuyerConcentration30s,
    "Progress > 0.00256623/s": rate == null ? null : rate > CURVE_LADDER.minProgressRate120s,
  };
  return { features, checks };
}

/** Strict point-in-time clock. Wallet trades stay in prices, never in flow. */
export function exitFeatures(tape: Trade[], ts: number, entryTs: number, entryPrice: number, footprint: number, target?: string): Record<string, number | null> | null {
  const i = beforeTime(tape, ts), last = tape[i];
  if (!last?.state || !(entryPrice > 0)) return null;
  const priceAt = (j: number) => {
    const t = tape[j];
    return t?.state ? spot({ ...t.state, x: t.state.x + (t.ts >= entryTs ? footprint : 0) }) : null;
  };
  const current = priceAt(i)!;
  let peak = entryPrice, trough = entryPrice;
  for (let j = i; j >= 0 && tape[j].ts >= entryTs; j--) {
    const p = priceAt(j);
    if (p == null) return null;
    peak = Math.max(peak, p); trough = Math.min(trough, p);
  }
  let net3 = 0, net10 = 0, sell3 = 0, maxSell10 = 0, buys10 = 0, count10 = 0;
  let lastBuy = 60, lastTrade = 60;
  for (let j = i; j >= 0 && tape[j].ts >= ts - 60; j--) {
    const t = tape[j];
    if (t.wallet === target) continue;
    // Flow does not need reconstructed reserves; the first AMM trades can have
    // valid amounts before enough pairs exist to fit k.
    if (!(t.sol > 0 && t.tokens > 0)) return null;
    const age = ts - t.ts;
    lastTrade = Math.min(lastTrade, age);
    if (t.side === "buy") lastBuy = Math.min(lastBuy, age);
    if (age <= 10) {
      count10++; buys10 += Number(t.side === "buy");
      net10 += t.sol * (t.side === "buy" ? 1 : -1);
      if (t.side === "sell") maxSell10 = Math.max(maxSell10, t.sol);
    }
    if (age <= 3) {
      net3 += t.sol * (t.side === "buy" ? 1 : -1);
      if (t.side === "sell") sell3 += t.sol;
    }
  }
  const p3 = priceAt(beforeTime(tape, ts - 3)), p10 = priceAt(beforeTime(tape, ts - 10));
  return {
    ret_since_entry: Math.log(current / entryPrice), drawdown_from_peak: Math.log(current / peak),
    runup_from_trough: Math.log(current / trough), ret_3s: p3 ? Math.log(current / p3) : null,
    ret_10s: p10 ? Math.log(current / p10) : null, net_flow_sol_3s: net3, net_flow_sol_10s: net10,
    sell_sol_3s: sell3, max_sell_sol_10s: maxSell10, buy_share_10s: count10 ? buys10 / count10 : null,
    trade_rate_10s: count10 / 10, secs_since_last_buy: lastBuy, secs_since_last_trade: lastTrade,
    duration_bucket: Math.max(0, DURATION_BUCKETS.filter((b) => ts - entryTs >= b).length - 1),
  };
}

export function treeHazard(features: Record<string, number | null>): number | null {
  const t = exitRecord.candidate.tree;
  let n = 0;
  while (t.left[n] !== -1) {
    const value = features[t.columns[t.feature[n]]];
    // Missing data never chooses a branch by accident.
    if (value == null || !Number.isFinite(value)) return null;
    n = value <= t.threshold[n] ? t.left[n] : t.right[n];
  }
  return t.hazard[n];
}

export function shouldScaleIn(features: Record<string, number | null> | null): boolean {
  return features?.ret_since_entry != null && features.ret_since_entry > 0 &&
    features.secs_since_last_trade != null && features.secs_since_last_trade < 3;
}
