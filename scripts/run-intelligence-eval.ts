/**
 * CLI: evaluate eval mints through strict intelligence contract.
 * Usage: pnpm run intelligence:eval
 */
import { bootDb } from "@/lib/db/client";
import { fetchDexMarketBatch } from "@/lib/dex/market-snapshot";
import { EVAL_MINTS_V1 } from "@/lib/continuation/eval-set";
import { evaluateUniverseIntelligence } from "@/lib/intelligence";
import type { IntelligenceInputSnapshot } from "@/lib/intelligence/types";

function dexToInput(mint: string, raw: import("@/lib/dex/market-snapshot").DexMarketSnapshot): IntelligenceInputSnapshot {
  const ageSec = raw.pairCreatedAt
    ? Math.max(0, (Date.now() - raw.pairCreatedAt.getTime()) / 1000)
    : 3600;
  return {
    mint,
    age_seconds: ageSec,
    liquidity_usd: raw.liqUsd,
    volume_m5: raw.volM5,
    volume_m30: raw.volH1 / 2,
    volume_h1: raw.volH1,
    price_change_m1: (raw.priceChangeM5 ?? 0) / 5,
    price_change_m5: raw.priceChangeM5 ?? 0,
    price_change_h1: raw.priceChangeH1 ?? 0,
    buy_sell_ratio: 0.55,
    unique_wallets_5m: 0,
    unique_wallets_30m: 0,
    holder_growth: 0,
    pool_count: 1,
    dex_rank: null,
    is_new_pool: ageSec < 600,
    migration_status: "dex",
  };
}

async function main() {
  await bootDb();
  const mints = EVAL_MINTS_V1.map((m) => m.mint);
  const markets = await fetchDexMarketBatch(mints);
  const inputs: IntelligenceInputSnapshot[] = [];

  for (const def of EVAL_MINTS_V1) {
    const raw = markets.get(def.mint);
    if (!raw) continue;
    inputs.push(dexToInput(def.mint, raw));
  }

  const results = evaluateUniverseIntelligence(inputs, { ops_healthy: true });
  console.log("\nIntelligence eval — strict contract\n");
  console.table(
    results.map((r) => {
      const sym = EVAL_MINTS_V1.find((e) => e.mint === r.mint)?.symbol ?? r.mint.slice(0, 8);
      return {
        symbol: sym,
        engine: r.engine,
        state: r.state,
        rank: r.rank_percentile.toFixed(2),
        signal: r.signal,
        auto: r.auto_trade_allowed,
        miss: r.miss_type ?? "—",
      };
    }),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
