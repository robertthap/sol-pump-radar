import "server-only";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { fetchMintSignalMarkers } from "@/lib/db/repos/decisions";

export async function fetchTokenChart(mint: string, hours: number) {
  const res = await getDb().execute(sql`
    WITH buckets AS (
      SELECT
        date_trunc('minute', ts) AS bucket,
        (array_agg(v_sol_after ORDER BY ts ASC) FILTER (WHERE v_sol_after IS NOT NULL))[1]::float8 AS open,
        MAX(v_sol_after)::float8 AS high,
        MIN(v_sol_after)::float8 AS low,
        (array_agg(v_sol_after ORDER BY ts DESC) FILTER (WHERE v_sol_after IS NOT NULL))[1]::float8 AS close,
        COUNT(*) FILTER (WHERE kind = 'buy')::int AS buys,
        COUNT(*) FILTER (WHERE kind = 'sell')::int AS sells
      FROM events
      WHERE mint = ${mint}
        AND ts > now() - (${sql.raw(String(hours))} || ' hours')::interval
        AND kind IN ('buy', 'sell')
      GROUP BY 1
      ORDER BY 1
    )
    SELECT
      to_char(bucket, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS t,
      open, high, low, close, buys, sells
    FROM buckets
    WHERE close IS NOT NULL
    LIMIT 2000
  `);
  type Raw = {
    t: string;
    open: number;
    high: number;
    low: number;
    close: number;
    buys: number;
    sells: number;
  };
  const candles = (res as unknown as { rows: Raw[] }).rows;
  const signals = await fetchMintSignalMarkers(mint, hours);
  return { candles, signals };
}

export async function fetchTokenTxs(mint: string, limit: number) {
  const res = await getDb().execute(sql`
    SELECT
      to_char(ts, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS ts,
      kind::text AS kind,
      side::text AS side,
      sol_amount::float8 AS sol_amount,
      v_sol_after::float8 AS v_sol,
      wallet::text AS wallet,
      signature::text AS signature
    FROM events
    WHERE mint = ${mint}
      AND kind IN ('buy', 'sell', 'create')
    ORDER BY ts DESC
    LIMIT ${sql.raw(String(limit))}
  `);
  type Raw = {
    ts: string;
    kind: string;
    side: string | null;
    sol_amount: number | null;
    v_sol: number | null;
    wallet: string | null;
    signature: string;
  };
  return (res as unknown as { rows: Raw[] }).rows.map((r) => ({
    ts: r.ts,
    kind: r.kind,
    side: r.side ?? (r.kind === "buy" ? "buy" : r.kind === "sell" ? "sell" : r.kind),
    solAmount: r.sol_amount,
    vSol: r.v_sol,
    wallet: r.wallet,
    signature: r.signature,
  }));
}
