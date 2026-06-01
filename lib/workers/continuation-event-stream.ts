import "server-only";
import { sql } from "drizzle-orm";
import { logger } from "@/lib/log";
import { isProfitSignalMode } from "@/lib/env";
import { fetchDexMarketBatchCached } from "@/lib/dex/snapshot-cache";
import { markMintHot } from "@/lib/intelligence/hot-mints";
import { emitBusEvent } from "@/lib/arch/event-bus";
import { normalizeDexSnapshot } from "@/lib/dex/normalizer";
import { fetchRecentContinuationMints } from "@/lib/db/repos/continuation-candidates";
import { getDb } from "@/lib/db/client";
import { touchWorker } from "@/lib/workers/heartbeat";
import type { NormalizedMintSnapshot } from "@/lib/continuation/types";
import {
  detectTriggerEvents,
  RANK_JUMP_PERCENTILE,
} from "@/lib/intelligence/event-triggers";
import { registerPriorSnapshot } from "@/lib/intelligence/state-delta-detector";
import type { IntelligenceInputSnapshot } from "@/lib/intelligence/types";

const log = logger("continuation-event-stream");
const TICK_MS = 5_000;
const MAX_WATCH = 40;

const lastSnap = new Map<string, NormalizedMintSnapshot>();

function normalizedToInput(mint: string, n: NormalizedMintSnapshot): IntelligenceInputSnapshot {
  return {
    mint,
    age_seconds: 3600,
    liquidity_usd: n.weightedLiqUsd,
    volume_m5: n.unifiedVol.m5,
    volume_m30: n.unifiedVol.h1 / 2,
    volume_h1: n.unifiedVol.h1,
    price_change_m1: (n.priceChangeM5 ?? 0) / 5,
    price_change_m5: n.priceChangeM5 ?? 0,
    price_change_h1: n.priceChangeH1 ?? 0,
    buy_sell_ratio: n.buySellRatio,
    unique_wallets_5m: 0,
    unique_wallets_30m: 0,
    holder_growth: 0,
    pool_count: n.poolCount,
    dex_rank: null,
    is_new_pool: false,
    migration_status: "dex",
  };
}

export async function startContinuationEventStream() {
  if (!isProfitSignalMode()) {
    return () => undefined;
  }

  log.info("continuation-event-stream starting", { tickMs: TICK_MS });
  let running = false;

  async function insertEvent(mint: string, kind: string, payload: object) {
    try {
      await getDb().execute(sql`
        INSERT INTO continuation_events (mint, kind, payload)
        VALUES (${mint}, ${JSON.stringify(payload)}::jsonb)
      `);
    } catch {
      /* optional table */
    }
  }

  async function tick() {
    if (running) return;
    running = true;
    const t0 = Date.now();
    try {
      const mints = (await fetchRecentContinuationMints(35)).slice(0, MAX_WATCH);
      if (!mints.length) {
        touchWorker("continuation-event-stream", { tickMs: Date.now() - t0 });
        return;
      }

      const markets = await fetchDexMarketBatchCached(mints);
      for (const mint of mints) {
        const raw = markets.get(mint);
        if (!raw) continue;
        const normalized = normalizeDexSnapshot(raw);
        const prior = lastSnap.get(mint) ?? null;

        if (prior) {
          const input = normalizedToInput(mint, normalized);
          const priorInput = normalizedToInput(mint, prior);
          const triggers = detectTriggerEvents({
            volume_m5: input.volume_m5,
            prior_volume_m5: priorInput.volume_m5,
            liquidity_usd: input.liquidity_usd,
            prior_liquidity_usd: priorInput.liquidity_usd,
            rank_percentile: 0.5,
            is_new_pool: normalized.poolCount > prior.poolCount,
            price_change_m5: input.price_change_m5,
            prior_price_change_m5: priorInput.price_change_m5,
          });
          for (const t of triggers) {
            if (t.kind === "volume_spike") await insertEvent(mint, "volume_spike", t.detail);
            else if (t.kind === "liquidity_jump") await insertEvent(mint, "liquidity_jump", t.detail);
            else if (t.kind === "new_pool_detected") await insertEvent(mint, "new_pool", t.detail);
            else if (t.kind === "price_burst") await insertEvent(mint, "price_burst", t.detail);
            markMintHot(mint, { score: 0.62, source: "EVENT", ttlMs: 90_000 });
            emitBusEvent({ type: "events:detected", at: Date.now(), mint, kind: t.kind });
          }
        }

        lastSnap.set(mint, normalized);
        registerPriorSnapshot(mint, normalizedToInput(mint, normalized));
      }

      touchWorker("continuation-event-stream", { tickMs: Date.now() - t0 });
    } catch (e) {
      log.warn("continuation-event-stream tick failed", { err: String(e) });
    } finally {
      running = false;
    }
  }

  void tick();
  const id = setInterval(() => void tick(), TICK_MS);
  return async () => clearInterval(id);
}
