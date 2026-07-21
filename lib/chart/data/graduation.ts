import "server-only";

import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { fetchPumpFunCoin } from "@/lib/pump/fun-api";
import { fetchDexMarketBatch } from "@/lib/dex/market-snapshot";
import { fetchMigrateTs } from "@/lib/chart/data/tradeStore";
import type { StreamStateRow } from "@/lib/chart/types";

const checkedAt = new Map<string, number>();
const CHECK_COOLDOWN_MS = 60_000;

/**
 * Virtual-vSol value at which the pump.fun bonding curve COMPLETES and the coin
 * migrates to PumpSwap. The DB shows a hard cap at ~115 (the cluster of graduated
 * coins). The migration on-chain event (CompleteEvent) never reaches our log
 * subscription, so we infer migration from the curve crossing this threshold —
 * the trade that first pushes a coin here is the migration moment, with an exact
 * on-chain timestamp (~$40-69k mcap). 113 leaves a small margin below the 115 cap.
 */
const CURVE_COMPLETE_V_SOL = 113;

/**
 * Real migration time from on-chain curve data: the FIRST bonding-curve trade that
 * pushed the coin past the completion threshold. null = the coin never crossed it
 * (not graduated, or DEX-discovered with no curve history in our events).
 */
export async function migrationTimeFromCurve(mint: string): Promise<number | null> {
  try {
    const res = await getDb().execute(sql`
      SELECT (EXTRACT(EPOCH FROM MIN(ts)) * 1000)::float8 AS migrate_ms
      FROM events
      WHERE mint = ${mint}
        AND kind IN ('buy', 'sell')
        AND venue = 'curve'
        AND v_sol_after >= ${CURVE_COMPLETE_V_SOL}
    `);
    // pg returns NUMERIC as a string — cast to float8 above so this is a real
    // number (Number.isFinite("…") is false, which silently nulled this out).
    const ms = (res as unknown as { rows: Array<{ migrate_ms: number | null }> }).rows[0]?.migrate_ms;
    return ms != null && Number.isFinite(ms) && ms > 0 ? ms : null;
  } catch {
    return null;
  }
}

/** Detect graduation once per mint (playbook §2). Does not retroactively rewrite history. */
export async function detectGraduation(mint: string): Promise<Partial<StreamStateRow> | null> {
  const now = Date.now();
  const last = checkedAt.get(mint) ?? 0;
  if (now - last < CHECK_COOLDOWN_MS) return null;
  checkedAt.set(mint, now);

  try {
    const coin = await fetchPumpFunCoin(mint);
    if (!coin) return null;
    const graduated = (coin.bondingPct ?? 0) >= 100 || coin.complete === true;
    if (!graduated) return null;
    // Use the REAL migration moment (the curve trade that completed the curve),
    // not "now" — otherwise chart_stream_state records the detection time and the
    // marker lands wherever the chart happened to be when we noticed.
    const curveMs = await migrationTimeFromCurve(mint);
    return {
      regime: "dex",
      graduationAt: new Date(curveMs ?? Date.now()),
    };
  } catch {
    return null;
  }
}

/** Best-effort graduation timestamp for stitching curve → DEX candles. */
export async function resolveGraduationMs(
  mint: string,
  stream: Pick<StreamStateRow, "graduationAt" | "regime">,
): Promise<number | null> {
  if (stream.graduationAt) return stream.graduationAt.getTime();

  const migrateTs = await fetchMigrateTs(mint);
  if (migrateTs != null) return migrateTs;

  // Accurate on-chain migration time: the curve trade that completed the bonding
  // curve (crossed ~115 vSol). Replaces the old pump-API `lastTradeAt`, which was
  // the coin's LATEST trade and put the marker on the newest candle.
  const curveMs = await migrationTimeFromCurve(mint);
  if (curveMs != null) return curveMs;

  if (stream.regime === "dex") {
    try {
      const markets = await fetchDexMarketBatch([mint]);
      const created = markets.get(mint)?.pairCreatedAt;
      if (created) return created.getTime();
    } catch {
      /* offline */
    }
  }

  return null;
}
