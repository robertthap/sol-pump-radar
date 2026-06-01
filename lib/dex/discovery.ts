import "server-only";
import { fetchDexBoostMints } from "@/lib/dex/market-snapshot";
import { fetchPumpFunCoins } from "@/lib/pump/fun-api";
import { ENGINE_B_EVAL_SET } from "@/lib/continuation/eval-set";

const MAX_MINTS = 100;

export async function discoverContinuationMints(): Promise<Map<string, string>> {
  const sources = new Map<string, string>();

  const [boosts, pumpCoins] = await Promise.all([
    fetchDexBoostMints(40),
    fetchPumpFunCoins({ limit: 40, sort: "last_trade_timestamp", order: "DESC" }).catch(() => []),
  ]);

  for (const b of boosts) sources.set(b, "dex_boost");
  for (const c of pumpCoins) {
    if (!sources.has(c.mint)) sources.set(c.mint, "pump_api");
  }
  for (const m of ENGINE_B_EVAL_SET) sources.set(m, "eval_set");

  const capped = [...sources.entries()].slice(0, MAX_MINTS);
  return new Map(capped);
}
