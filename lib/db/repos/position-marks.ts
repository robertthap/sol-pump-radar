import "server-only";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";

export type PositionMarkInsert = {
  positionId: bigint;
  ageS: number;
  pct: number;
  peakPct: number;
  mcapUsd: number | null;
  graduated: boolean;
  lastTradeAgeS: number | null;
  curveTrades60s: number | null;
  curveWallets60s: number | null;
};

/**
 * Append sampled marks for open positions. Best-effort by design: this is
 * research instrumentation on the exit path, and a failed insert must never
 * stop a position from being exited. Callers do not await correctness.
 */
export async function insertPositionMarks(marks: PositionMarkInsert[]): Promise<number> {
  if (marks.length === 0) return 0;
  const values = marks.map(
    (m) => sql`(${m.positionId}, ${m.ageS}, ${m.pct}, ${m.peakPct}, ${m.mcapUsd},
                ${m.graduated}, ${m.lastTradeAgeS}, ${m.curveTrades60s}, ${m.curveWallets60s})`,
  );
  await getDb().execute(sql`
    INSERT INTO position_marks
      (position_id, age_s, pct, peak_pct, mcap_usd, graduated, last_trade_age_s, curve_trades_60s, curve_wallets_60s)
    VALUES ${sql.join(values, sql`, `)}
  `);
  return marks.length;
}

export type PositionMarkRow = {
  positionId: string;
  ageS: number;
  pct: number;
  peakPct: number;
  mcapUsd: number | null;
  graduated: boolean;
  lastTradeAgeS: number | null;
  curveTrades60s: number | null;
  curveWallets60s: number | null;
};

/** Marks for a set of positions, oldest first per position - the replay input. */
export async function fetchMarksForPositions(positionIds: string[]): Promise<Map<string, PositionMarkRow[]>> {
  const out = new Map<string, PositionMarkRow[]>();
  if (positionIds.length === 0) return out;
  const res = await getDb().execute(sql`
    SELECT position_id::text AS position_id, age_s, pct, peak_pct, mcap_usd,
           graduated, last_trade_age_s, curve_trades_60s, curve_wallets_60s
    FROM position_marks
    WHERE position_id = ANY(${positionIds.map((id) => BigInt(id))}::bigint[])
    ORDER BY position_id, age_s ASC
  `);
  for (const r of (res as unknown as { rows: Array<Record<string, unknown>> }).rows) {
    const id = String(r.position_id);
    const list = out.get(id) ?? [];
    list.push({
      positionId: id,
      ageS: Number(r.age_s),
      pct: Number(r.pct),
      peakPct: Number(r.peak_pct),
      mcapUsd: r.mcap_usd == null ? null : Number(r.mcap_usd),
      graduated: r.graduated === true,
      lastTradeAgeS: r.last_trade_age_s == null ? null : Number(r.last_trade_age_s),
      curveTrades60s: r.curve_trades_60s == null ? null : Number(r.curve_trades_60s),
      curveWallets60s: r.curve_wallets_60s == null ? null : Number(r.curve_wallets_60s),
    });
    out.set(id, list);
  }
  return out;
}
