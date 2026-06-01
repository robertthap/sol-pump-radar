import "server-only";
import type { DexMarketSnapshot } from "@/lib/dex/market-snapshot";
import type { NormalizedMintSnapshot } from "@/lib/continuation/types";

export function normalizeDexSnapshot(snap: DexMarketSnapshot): NormalizedMintSnapshot {
  const pools = snap.pools;
  const totalLiq = Math.max(snap.liqUsd, 1);
  const primaryLiq = pools[0]?.liqUsd ?? snap.liqUsd;
  const primaryShare = primaryLiq / totalLiq;
  const poolStabilityFactor = Math.min(1, 0.5 + primaryShare * 0.5 + Math.min(snap.poolCount, 4) * 0.1);

  let singlePoolSpikeFlag = false;
  if (snap.poolCount <= 1 && snap.volAcceleration > 2.5) {
    singlePoolSpikeFlag = true;
  }
  if (snap.poolCount > 1) {
    const maxPoolVolShare = 0.85;
    const primaryVolEst = snap.volM5;
    if (primaryVolEst > snap.volM5 * maxPoolVolShare && primaryShare < 0.1) {
      singlePoolSpikeFlag = true;
    }
  }

  const weightedLiqUsd =
    primaryLiq * 0.7 +
    pools.slice(1).reduce((s, p) => s + Math.min(p.liqUsd, primaryLiq * 0.5), 0) * 0.3;

  return {
    mint: snap.mint,
    symbol: snap.symbol,
    alignedTs: Date.now(),
    weightedLiqUsd,
    unifiedVol: { m5: snap.volM5, h1: snap.volH1, h24: snap.volH24 },
    volAcceleration: snap.volAcceleration,
    poolCount: snap.poolCount,
    poolStabilityFactor,
    primaryPool: snap.primaryPool,
    primaryDex: snap.primaryDex,
    priceChangeM5: snap.priceChangeM5,
    priceChangeH1: snap.priceChangeH1,
    priceChangeH24: snap.priceChangeH24,
    buysM5: snap.buysM5,
    sellsM5: snap.sellsM5,
    buySellRatio: snap.buySellRatio,
    singlePoolSpikeFlag,
  };
}
