/**
 * Verification: the landed gate/velocity changes make a FRESH, accelerating
 * launch tradable in hybrid/launch mode while profit mode (the old behavior)
 * still rejects it. Exercises the real production path:
 *   evaluateMintIntelligence → fuseEngineIntelligence → engineA + launch-velocity
 *   → mode/stage-aware auto-gate.
 *
 * Run: pnpm verify:launch
 */
import { evaluateMintIntelligence } from "../lib/intelligence/dual-engine";
import { defaultGateConfig } from "../lib/intelligence/gate-config";
import type {
  IntelligenceInputSnapshot,
  IntelligenceEvaluateContext,
} from "../lib/intelligence/types";

function freshLaunch(): IntelligenceInputSnapshot {
  return {
    mint: "FreshLaunchTest1111111111111111111111111111",
    age_seconds: 90,
    liquidity_usd: 4_000, // well under the old $20k Engine-A floor
    volume_m5: 30,
    volume_m30: 60, // vol2x: 30 >= (60/6)*2 = 20 ✓
    volume_h1: 60,
    price_change_m1: 8,
    price_change_m5: 18,
    price_change_h1: 12,
    buy_sell_ratio: 0.75,
    unique_wallets_5m: 9,
    unique_wallets_30m: 9,
    holder_growth: 0.2,
    pool_count: 1,
    dex_rank: null,
    is_new_pool: true,
    migration_status: "curve",
  };
}

function ctxFor(gateMode: "hybrid" | "profit" | "launch"): IntelligenceEvaluateContext {
  return {
    cross_mint: { rank_percentile: 0.62, velocity_rank: 0.6, liquidity_rank: 0.4 },
    prior_liquidity_usd: 2_500, // +60% liquidity growth → strong launch velocity
    prior_volume_m5: 12,
    risk_flags: {},
    in_universe: true,
    normalized: true,
    ops_healthy: true,
    universe_size: 40,
    gateConfig: defaultGateConfig(gateMode),
  };
}

const failures: string[] = [];

function check(label: string, cond: boolean, detail: string) {
  if (cond) console.log(`  ✓ ${label} — ${detail}`);
  else {
    failures.push(label);
    console.error(`  ✗ ${label} — ${detail}`);
  }
}

function main() {
  console.log("\n=== verify: fresh-launch entry (gate + velocity) ===\n");

  const hybrid = evaluateMintIntelligence(freshLaunch(), ctxFor("hybrid"));
  console.log(`hybrid → signal=${hybrid.signal} allowed=${hybrid.auto_trade_allowed}`);
  console.log(`         reason=${hybrid.reason}\n`);
  check(
    "hybrid mode ADMITS the fresh $4k launch",
    hybrid.signal === "BUY_STRONG" && hybrid.auto_trade_allowed === true,
    `expected BUY_STRONG + allowed`,
  );

  const profit = evaluateMintIntelligence(freshLaunch(), ctxFor("profit"));
  console.log(`profit → signal=${profit.signal} allowed=${profit.auto_trade_allowed}`);
  console.log(`         reason=${profit.reason}\n`);
  check(
    "profit mode REJECTS the same fresh launch (old behavior)",
    profit.auto_trade_allowed === false,
    `expected not-allowed`,
  );

  // Thinning-liquidity launch must be vetoed by velocity even in hybrid.
  const thinning = evaluateMintIntelligence(freshLaunch(), {
    ...ctxFor("hybrid"),
    prior_liquidity_usd: 9_000, // liquidity fell 4000 < 0.85×9000 → veto
  });
  console.log(`thinning → signal=${thinning.signal} allowed=${thinning.auto_trade_allowed}`);
  check(
    "hybrid VETOES a thinning-liquidity launch",
    thinning.auto_trade_allowed === false,
    `velocity veto should block`,
  );

  console.log("");
  if (failures.length) {
    console.error(`FAILED: ${failures.length} check(s)`);
    process.exit(1);
  }
  console.log("All checks passed ✅");
}

main();
