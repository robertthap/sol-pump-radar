import "server-only";
import { sql } from "drizzle-orm";
import { bootDb, getDb } from "@/lib/db/client";
import type { TapeEvent } from "@/lib/strategies/catalog";

export type ReplayData = { events: TapeEvent[]; latestTs: number | null; fromTs: number | null; selectedMints: number; rowLimit: number };

/** Read-only bounded sample. Load full mint histories so old rungs cannot re-arm. */
export async function loadStrategyReplayData(days: number, mintLimit: number): Promise<ReplayData> {
  await bootDb();
  const db = getDb();
  const latestResult = await db.execute(sql`SELECT extract(epoch FROM max(ts))::float8 AS ts FROM events WHERE kind IN ('buy', 'sell', 'migrate')`);
  const latestTs = (latestResult as unknown as { rows: Array<{ ts: number | null }> }).rows[0]?.ts ?? null;
  const rowLimit = 150_000;
  if (latestTs == null) return { events: [], latestTs, fromTs: null, selectedMints: 0, rowLimit };
  const fromTs = latestTs - days * 86400;
  const result = await db.execute(sql`
    WITH chosen AS (
      SELECT mint FROM events
      WHERE mint IS NOT NULL AND ts >= to_timestamp(${fromTs})
        AND kind IN ('buy', 'sell', 'migrate')
      GROUP BY mint ORDER BY max(ts) DESC, mint LIMIT ${mintLimit}
    )
    SELECT e.id::float8, e.mint, extract(epoch FROM e.ts)::float8 AS ts,
      e.slot::float8, e.kind, e.venue, e.pool, e.wallet, e.side,
      e.sol_amount::float8 AS sol, e.token_amount::float8 AS tokens, e.v_sol_after::float8 AS "vSol"
    FROM events e JOIN chosen c ON e.mint = c.mint
    WHERE e.kind IN ('buy', 'sell', 'migrate') AND e.ts <= to_timestamp(${latestTs})
    ORDER BY e.slot, e.id LIMIT ${rowLimit + 1}
  `);
  const events = (result as unknown as { rows: TapeEvent[] }).rows;
  if (events.length > rowLimit) throw new Error("This sample exceeds 150,000 events. Choose fewer mints; partial histories are not replayed.");
  return { events, latestTs, fromTs, selectedMints: new Set(events.map((e) => e.mint)).size, rowLimit };
}
