import "server-only";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import {
  detectTriggerEvents,
  eventImpulseFromTriggers,
} from "@/lib/intelligence/event-triggers";
import type { IntelligenceInputSnapshot, TriggerEvent } from "@/lib/intelligence/types";

import { BoundedMap } from "@/lib/shared/bounded-map";

const DEFAULT_WINDOW_MS = 10_000;

/** Bounded: this held one full snapshot per mint EVER scored, for the lifetime
 *  of the worker. Only the most recent mints are ever compared against. */
const PRIOR_SNAPSHOT_MAX = 2_000;
const priorSnapshots = new BoundedMap<string, IntelligenceInputSnapshot>(PRIOR_SNAPSHOT_MAX);

export function registerPriorSnapshot(mint: string, snap: IntelligenceInputSnapshot) {
  priorSnapshots.set(mint, snap);
}

export function getPriorSnapshot(mint: string): IntelligenceInputSnapshot | null {
  return priorSnapshots.get(mint) ?? null;
}

export function updatePriorSnapshotAfterCommit(mint: string, snap: IntelligenceInputSnapshot) {
  priorSnapshots.set(mint, { ...snap });
}

const DB_KIND_MAP: Record<string, TriggerEvent["kind"]> = {
  volume_spike: "volume_spike",
  liquidity_jump: "liquidity_jump",
  rank_jump: "rank_jump",
  new_pool: "new_pool_detected",
  price_burst: "price_burst",
  migration_event: "migration_event",
};

/** Merge continuation_events (last window) with snapshot diff. */
export async function aggregateDeltaEvents(
  mint: string,
  current: IntelligenceInputSnapshot,
  opts?: {
    windowMs?: number;
    cross_rank?: number;
    prior_rank?: number;
  },
): Promise<{ trigger_events: TriggerEvent[]; event_impulse: number }> {
  const windowMs = opts?.windowMs ?? DEFAULT_WINDOW_MS;
  const prior = priorSnapshots.get(mint);
  const fromDiff = detectTriggerEvents({
    volume_m5: current.volume_m5,
    prior_volume_m5: prior?.volume_m5,
    liquidity_usd: current.liquidity_usd,
    prior_liquidity_usd: prior?.liquidity_usd,
    rank_percentile: opts?.cross_rank ?? 0.5,
    prior_rank_percentile: opts?.prior_rank,
    is_new_pool: current.is_new_pool,
    migration_status: current.migration_status,
    prior_migration_status: prior?.migration_status,
    price_change_m5: current.price_change_m5,
    prior_price_change_m5: prior?.price_change_m5,
  });

  const fromDb: TriggerEvent[] = [];
  try {
    const res = await getDb().execute(sql`
      SELECT kind, payload
      FROM continuation_events
      WHERE mint = ${mint}
        AND ts > now() - (${sql.raw(String(windowMs / 1000))} || ' seconds')::interval
      ORDER BY ts ASC
      LIMIT 50
    `);
    const rows = (res as unknown as { rows: Array<{ kind: string; payload: unknown }> }).rows;
    for (const row of rows) {
      const kind = DB_KIND_MAP[row.kind] ?? (row.kind as TriggerEvent["kind"]);
      fromDb.push({
        kind,
        detail:
          typeof row.payload === "object" && row.payload !== null
            ? (row.payload as Record<string, number | string | boolean>)
            : {},
      });
    }
  } catch {
    /* table optional */
  }

  const merged = dedupeEvents([...fromDb, ...fromDiff]);
  return {
    trigger_events: merged,
    event_impulse: eventImpulseFromTriggers(merged),
  };
}

/** One DB round-trip for all mints on an intelligence-commit tick. */
export async function aggregateDeltaEventsBatch(
  mints: string[],
  inputs: Map<string, IntelligenceInputSnapshot>,
  crossRanks: Map<string, number>,
  opts?: { windowMs?: number },
): Promise<Map<string, { trigger_events: TriggerEvent[]; event_impulse: number }>> {
  const windowMs = opts?.windowMs ?? DEFAULT_WINDOW_MS;
  const out = new Map<string, { trigger_events: TriggerEvent[]; event_impulse: number }>();

  if (!mints.length) return out;

  const eventsByMint = new Map<string, TriggerEvent[]>();
  try {
    const list = mints.map((m) => `'${m.replace(/'/g, "''")}'`).join(",");
    const res = await getDb().execute(sql`
      SELECT mint, kind, payload
      FROM continuation_events
      WHERE mint = ANY(ARRAY[${sql.raw(list)}]::text[])
        AND ts > now() - (${sql.raw(String(windowMs / 1000))} || ' seconds')::interval
      ORDER BY ts ASC
      LIMIT 500
    `);
    for (const row of (res as unknown as { rows: Array<{ mint: string; kind: string; payload: unknown }> })
      .rows) {
      const kind = DB_KIND_MAP[row.kind] ?? (row.kind as TriggerEvent["kind"]);
      const ev: TriggerEvent = {
        kind,
        detail:
          typeof row.payload === "object" && row.payload !== null
            ? (row.payload as Record<string, number | string | boolean>)
            : {},
      };
      const list = eventsByMint.get(row.mint) ?? [];
      list.push(ev);
      eventsByMint.set(row.mint, list);
    }
  } catch {
    /* optional */
  }

  for (const mint of mints) {
    const current = inputs.get(mint);
    if (!current) continue;
    const prior = priorSnapshots.get(mint);
    const fromDiff = detectTriggerEvents({
      volume_m5: current.volume_m5,
      prior_volume_m5: prior?.volume_m5,
      liquidity_usd: current.liquidity_usd,
      prior_liquidity_usd: prior?.liquidity_usd,
      rank_percentile: crossRanks.get(mint) ?? 0.5,
      prior_rank_percentile: undefined,
      is_new_pool: current.is_new_pool,
      migration_status: current.migration_status,
      prior_migration_status: prior?.migration_status,
      price_change_m5: current.price_change_m5,
      prior_price_change_m5: prior?.price_change_m5,
    });
    const merged = dedupeEvents([...(eventsByMint.get(mint) ?? []), ...fromDiff]);
    out.set(mint, {
      trigger_events: merged,
      event_impulse: eventImpulseFromTriggers(merged),
    });
  }

  return out;
}

function dedupeEvents(events: TriggerEvent[]): TriggerEvent[] {
  const seen = new Set<string>();
  const out: TriggerEvent[] = [];
  for (const e of events) {
    const key = e.kind;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

export function detectStateDelta(
  current: IntelligenceInputSnapshot,
  prior: IntelligenceInputSnapshot | null,
): TriggerEvent[] {
  if (!prior) return [];
  return detectTriggerEvents({
    volume_m5: current.volume_m5,
    prior_volume_m5: prior.volume_m5,
    liquidity_usd: current.liquidity_usd,
    prior_liquidity_usd: prior.liquidity_usd,
    rank_percentile: 0.5,
    prior_rank_percentile: 0.5,
    is_new_pool: current.is_new_pool && !prior.is_new_pool,
    migration_status: current.migration_status,
    prior_migration_status: prior.migration_status,
    price_change_m5: current.price_change_m5,
    prior_price_change_m5: prior.price_change_m5,
  });
}
