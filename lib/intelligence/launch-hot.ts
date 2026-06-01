import "server-only";
import type { ParsedPumpEvent } from "@/lib/pump/parser";
import { fetchMintLaunchActivity } from "@/lib/db/repos/events";
import { launchHotEnv } from "@/lib/env";
import { markLaunchHot } from "@/lib/intelligence/hot-mints";
import {
  scoreLaunchHot as scoreLaunchHotPure,
  type LaunchActivity,
  type LaunchGateResult,
} from "@/lib/intelligence/launch-hot-gate";
import { logger } from "@/lib/log";

const log = logger("launch-hot");

export type { LaunchActivity, LaunchGateResult };

export function scoreLaunchHot(activity: LaunchActivity): LaunchGateResult {
  return scoreLaunchHotPure(activity, launchHotEnv());
}

const pendingLaunches = new Map<string, { creatorWallet: string; since: number }>();

function buildActivity(
  mint: string,
  creatorWallet: string,
  batch: ParsedPumpEvent[],
  db?: { tradeCount: number; uniqueWallets: number; maxVSol: number },
): LaunchActivity {
  const wallets = new Set<string>([creatorWallet]);
  let tradeCount = 0;
  let maxVSol = 0;
  for (const e of batch) {
    if (e.mint !== mint || (e.kind !== "buy" && e.kind !== "sell")) continue;
    tradeCount++;
    wallets.add(e.wallet);
    if (e.vSolAfter != null && e.vSolAfter > maxVSol) maxVSol = e.vSolAfter;
  }
  if (db) {
    tradeCount = Math.max(tradeCount, db.tradeCount);
    maxVSol = Math.max(maxVSol, db.maxVSol);
    if (db.uniqueWallets > wallets.size) {
      return {
        mint,
        creatorWallet,
        tradeCount,
        uniqueWallets: db.uniqueWallets,
        maxVSol,
      };
    }
  }
  return {
    mint,
    creatorWallet,
    tradeCount,
    uniqueWallets: wallets.size,
    maxVSol,
  };
}

/**
 * Tracks fresh creates across flushes; gated HOT_LAUNCH when activity confirms (not on create alone).
 */
export async function processLaunchHotPipeline(batch: ParsedPumpEvent[]): Promise<number> {
  const cfg = launchHotEnv();
  const now = Date.now();

  for (const e of batch) {
    if (e.kind === "create") {
      pendingLaunches.set(e.mint, { creatorWallet: e.wallet, since: now });
    }
  }

  for (const [mint, p] of pendingLaunches) {
    if (now - p.since > cfg.pendingMaxMs) pendingLaunches.delete(mint);
  }

  const toCheck = new Set<string>();
  for (const mint of pendingLaunches.keys()) toCheck.add(mint);
  for (const e of batch) {
    if ((e.kind === "buy" || e.kind === "sell") && pendingLaunches.has(e.mint)) {
      toCheck.add(e.mint);
    }
  }
  if (!toCheck.size) return 0;

  let dbStats = new Map<string, { tradeCount: number; uniqueWallets: number; maxVSol: number }>();
  try {
    dbStats = await fetchMintLaunchActivity([...toCheck], cfg.lookbackSec);
  } catch {
    /* optional */
  }

  const candidates: LaunchGateResult[] = [];
  for (const mint of toCheck) {
    const pending = pendingLaunches.get(mint);
    if (!pending) continue;
    const activity = buildActivity(mint, pending.creatorWallet, batch, dbStats.get(mint));
    const gate = scoreLaunchHot(activity);
    if (gate.qualified) {
      candidates.push(gate);
      pendingLaunches.delete(mint);
    }
  }

  candidates.sort((a, b) => b.hotScore - a.hotScore);
  let marked = 0;
  for (const g of candidates.slice(0, cfg.maxMarkPerFlush)) {
    markLaunchHot(g.mint, g.hotScore, cfg.ttlMs);
    marked++;
  }

  if (marked > 0) {
    log.debug("launch hot marked", {
      marked,
      candidates: candidates.length,
      top: candidates[0]?.mint.slice(0, 8),
    });
  }

  return marked;
}
