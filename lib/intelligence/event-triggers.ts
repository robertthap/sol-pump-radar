import "server-only";
import type { TriggerEvent, TriggerEventKind } from "@/lib/intelligence/types";

/** Spec-aligned event override thresholds. */
export const VOL_SPIKE_MULTIPLIER = 2.5;
export const LIQUIDITY_JUMP_PCT = 0.15;
export const RANK_JUMP_PERCENTILE = 0.2;

export function detectTriggerEvents(input: {
  volume_m5: number;
  prior_volume_m5?: number;
  liquidity_usd: number;
  prior_liquidity_usd?: number;
  rank_percentile: number;
  prior_rank_percentile?: number;
  is_new_pool?: boolean;
  migration_status?: string;
  prior_migration_status?: string;
  price_change_m5?: number;
  prior_price_change_m5?: number;
}): TriggerEvent[] {
  const events: TriggerEvent[] = [];

  if (input.prior_volume_m5 != null && input.prior_volume_m5 > 0) {
    const ratio = input.volume_m5 / input.prior_volume_m5;
    if (ratio >= VOL_SPIKE_MULTIPLIER) {
      events.push({
        kind: "volume_spike",
        detail: { ratio, baseline: input.prior_volume_m5, current: input.volume_m5 },
      });
    }
  }

  if (input.prior_liquidity_usd != null && input.prior_liquidity_usd > 0) {
    const liqDelta =
      (input.liquidity_usd - input.prior_liquidity_usd) / input.prior_liquidity_usd;
    if (liqDelta >= LIQUIDITY_JUMP_PCT) {
      events.push({
        kind: "liquidity_jump",
        detail: { liqDelta, from: input.prior_liquidity_usd, to: input.liquidity_usd },
      });
    }
  }

  if (input.prior_rank_percentile != null) {
    const rankJump = input.rank_percentile - input.prior_rank_percentile;
    if (rankJump >= RANK_JUMP_PERCENTILE) {
      events.push({
        kind: "rank_jump",
        detail: { from: input.prior_rank_percentile, to: input.rank_percentile, delta: rankJump },
      });
    }
  }

  if (input.is_new_pool) {
    events.push({ kind: "new_pool_detected", detail: { is_new_pool: true } });
  }

  if (
    input.prior_migration_status === "curve" &&
    (input.migration_status === "dex" || input.migration_status === "graduated")
  ) {
    events.push({
      kind: "migration_event",
      detail: { from: input.prior_migration_status, to: input.migration_status ?? "dex" },
    });
  }

  const m5 = input.price_change_m5 ?? 0;
  const pm5 = input.prior_price_change_m5 ?? 0;
  if (m5 - pm5 > 12) {
    events.push({ kind: "price_burst", detail: { m5, prior_m5: pm5 } });
  }

  return events;
}

export function eventImpulseFromTriggers(events: TriggerEvent[]): number {
  let impulse = 0;
  for (const e of events) {
    switch (e.kind as TriggerEventKind) {
      case "volume_spike":
        impulse += 0.4;
        break;
      case "liquidity_jump":
        impulse += 0.3;
        break;
      case "rank_jump":
        impulse += 0.35;
        break;
      case "new_pool_detected":
        impulse += 0.2;
        break;
      case "migration_event":
        impulse += 0.45;
        break;
      case "price_burst":
        impulse += 0.25;
        break;
    }
  }
  return Math.min(1, impulse);
}
