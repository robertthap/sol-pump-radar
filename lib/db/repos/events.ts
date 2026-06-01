import "server-only";
import { desc, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { events } from "@/lib/db/schema";
import { normalizeBlockTimeSec, type ParsedPumpEvent } from "@/lib/pump/parser";
import { logger } from "@/lib/log";

export type EventKindFilter = "create" | "trade" | "buy" | "sell" | "migrate" | "all";

const log = logger("repo:events");

function eventToRow(e: ParsedPumpEvent) {
  const sec = normalizeBlockTimeSec(e.blockTime, Math.floor(Date.now() / 1000));
  const ts = new Date(sec * 1000);
  if (!Number.isFinite(ts.getTime())) {
    throw new RangeError(`Invalid event time for ${e.signature}`);
  }
  switch (e.kind) {
    case "buy":
    case "sell":
      return {
        signature: e.signature,
        instructionIndex: 0,
        slot: e.slot,
        ts,
        kind: e.kind,
        mint: e.mint,
        wallet: e.wallet,
        side: e.side,
        solAmount: e.solAmount,
        tokenAmount: e.tokenAmount,
        vSolAfter: e.vSolAfter,
        program: "pumpfun",
        raw: null,
      };
    case "create":
      return {
        signature: e.signature,
        instructionIndex: 0,
        slot: e.slot,
        ts,
        kind: "create" as const,
        mint: e.mint,
        wallet: e.wallet,
        side: null,
        solAmount: null,
        tokenAmount: null,
        vSolAfter: null,
        program: "pumpfun",
        raw: { name: e.name, symbol: e.symbol, uri: e.uri, bondingCurve: e.bondingCurve },
      };
    case "migrate":
      return {
        signature: e.signature,
        instructionIndex: 0,
        slot: e.slot,
        ts,
        kind: "migrate" as const,
        mint: e.mint,
        wallet: e.wallet,
        side: null,
        solAmount: null,
        tokenAmount: null,
        vSolAfter: null,
        program: "pumpfun",
        raw: { bondingCurve: e.bondingCurve },
      };
  }
}

/** Recent launch activity for gated HOT_LAUNCH (ingestor). */
export async function fetchMintLaunchActivity(
  mints: string[],
  windowSec = 30,
): Promise<
  Map<string, { tradeCount: number; uniqueWallets: number; maxVSol: number }>
> {
  const out = new Map<string, { tradeCount: number; uniqueWallets: number; maxVSol: number }>();
  if (!mints.length) return out;
  const list = mints.map((m) => `'${m.replace(/'/g, "''")}'`).join(",");
  try {
    const res = await getDb().execute(sql`
      SELECT
        mint,
        COUNT(*) FILTER (WHERE kind IN ('buy', 'sell'))::int AS trade_count,
        COUNT(DISTINCT wallet) FILTER (WHERE kind IN ('buy', 'sell') AND wallet IS NOT NULL)::int AS unique_wallets,
        COALESCE(MAX(v_sol_after) FILTER (WHERE v_sol_after IS NOT NULL), 0)::float8 AS max_v_sol
      FROM events
      WHERE mint = ANY(ARRAY[${sql.raw(list)}]::text[])
        AND ts > now() - (${sql.raw(String(windowSec))} || ' seconds')::interval
      GROUP BY mint
    `);
    for (const row of (
      res as unknown as {
        rows: Array<{
          mint: string;
          trade_count: number;
          unique_wallets: number;
          max_v_sol: number;
        }>;
      }
    ).rows) {
      out.set(row.mint, {
        tradeCount: row.trade_count ?? 0,
        uniqueWallets: Math.max(1, row.unique_wallets ?? 0),
        maxVSol: row.max_v_sol ?? 0,
      });
    }
  } catch {
    /* optional */
  }
  return out;
}

export async function insertEvents(batch: ParsedPumpEvent[]): Promise<number> {
  if (batch.length === 0) return 0;
  const rows = batch.map(eventToRow);
  try {
    await getDb().insert(events).values(rows).onConflictDoNothing();
    return rows.length;
  } catch (e) {
    log.warn("batch insert failed; trying one by one", { err: String(e), n: rows.length });
    let ok = 0;
    for (const row of rows) {
      try {
        await getDb().insert(events).values(row).onConflictDoNothing();
        ok++;
      } catch (err) {
        log.debug("single insert failed", { sig: row.signature, err: String(err) });
      }
    }
    return ok;
  }
}

/** API snapshot rows so analytics has price hooks for trending mints without WSS ingest. */
export async function insertSnapshotEvents(
  rows: Array<{ mint: string; vSol: number }>,
): Promise<number> {
  if (rows.length === 0) return 0;
  const slot = BigInt(Math.floor(Date.now() / 400));
  const ts = new Date();
  let ok = 0;
  for (const r of rows) {
    const sig = `snapshot-${r.mint.slice(0, 16)}-${Math.floor(Date.now() / 60_000)}`;
    try {
      await getDb()
        .insert(events)
        .values({
          signature: sig,
          instructionIndex: 0,
          slot,
          ts,
          kind: "snapshot",
          mint: r.mint,
          wallet: null,
          side: null,
          solAmount: null,
          tokenAmount: null,
          vSolAfter: r.vSol,
          program: "trend-scanner",
          raw: null,
        })
        .onConflictDoNothing();
      ok++;
    } catch {
      /* ignore duplicate snapshot minute */
    }
  }
  return ok;
}

export type RecentEventDto = {
  id: string;
  ts: string;
  kind: string;
  mint: string | null;
  wallet: string | null;
  side: string | null;
  solAmount: number | null;
  tokenAmount: number | null;
  signature: string;
};

export async function fetchRecentEvents(
  limit = 25,
  kind: EventKindFilter = "all",
): Promise<RecentEventDto[]> {
  const base = getDb().select().from(events);
  let q;
  if (kind === "all") {
    q = base;
  } else if (kind === "trade") {
    q = base.where(inArray(events.kind, ["buy", "sell"]));
  } else {
    q = base.where(eq(events.kind, kind));
  }
  const rows = await q.orderBy(desc(events.ts)).limit(limit);
  return rows.map((r) => ({
    id: r.id.toString(),
    ts: r.ts.toISOString(),
    kind: r.kind,
    mint: r.mint,
    wallet: r.wallet,
    side: r.side,
    solAmount: r.solAmount,
    tokenAmount: r.tokenAmount,
    signature: r.signature,
  }));
}

export type RecentCreateDto = RecentEventDto & {
  symbol: string | null;
  name: string | null;
};

export async function fetchRecentCreates(limit = 25): Promise<RecentCreateDto[]> {
  const res = await getDb().execute(sql`
    SELECT
      e.id::text AS id,
      e.ts AS ts,
      e.kind AS kind,
      e.mint AS mint,
      e.wallet AS wallet,
      e.side AS side,
      e.sol_amount AS sol_amount,
      e.token_amount AS token_amount,
      e.signature AS signature,
      t.symbol AS symbol,
      t.name AS name
    FROM events e
    LEFT JOIN tokens t ON t.mint = e.mint
    WHERE e.kind = 'create'
    ORDER BY e.ts DESC
    LIMIT ${sql.raw(String(Math.max(1, Math.min(200, limit))))}
  `);
  type Row = {
    id: string;
    ts: Date | string;
    kind: string;
    mint: string | null;
    wallet: string | null;
    side: string | null;
    sol_amount: number | null;
    token_amount: number | null;
    signature: string;
    symbol: string | null;
    name: string | null;
  };
  const rows = (res as unknown as { rows: Row[] }).rows;
  return rows.map((r) => ({
    id: r.id,
    ts: r.ts instanceof Date ? r.ts.toISOString() : String(r.ts),
    kind: r.kind,
    mint: r.mint,
    wallet: r.wallet,
    side: r.side,
    solAmount: r.sol_amount,
    tokenAmount: r.token_amount,
    signature: r.signature,
    symbol: r.symbol,
    name: r.name,
  }));
}

export async function countSinceBoot(): Promise<{ events: number; creates: number; trades: number; migrations: number }> {
  const res = await getDb().execute(sql`
    SELECT
      (SELECT count(*) FROM events)::int AS events,
      (SELECT count(*) FROM events WHERE kind = 'create')::int AS creates,
      (SELECT count(*) FROM events WHERE kind IN ('buy','sell'))::int AS trades,
      (SELECT count(*) FROM events WHERE kind = 'migrate')::int AS migrations
  `);
  const row = (res as unknown as {
    rows: Array<{ events: number; creates: number; trades: number; migrations: number }>;
  }).rows[0];
  return row ?? { events: 0, creates: 0, trades: 0, migrations: 0 };
}

/** Latest bonding-curve vSol per mint from events (batch). */
export async function latestVSolBatch(mints: string[]): Promise<Map<string, number>> {
  if (mints.length === 0) return new Map();
  const list = mints.map((m) => `'${m.replace(/'/g, "''")}'`).join(",");
  const res = await getDb().execute(sql`
    SELECT DISTINCT ON (e.mint) e.mint::text AS mint, e.v_sol_after::float8 AS v
    FROM events e
    WHERE e.mint = ANY(ARRAY[${sql.raw(list)}]::text[])
      AND e.v_sol_after IS NOT NULL
    ORDER BY e.mint, e.ts DESC
  `);
  const rows = (res as unknown as { rows: Array<{ mint: string; v: number | null }> }).rows;
  const out = new Map<string, number>();
  for (const r of rows) if (r.v != null) out.set(r.mint, r.v);
  return out;
}

export async function latestVSolForMint(mint: string): Promise<number | null> {
  const batch = await latestVSolBatch([mint]);
  return batch.get(mint) ?? null;
}

export type MintTradeEvent = {
  ts: string;
  kind: string;
  side: string;
  solAmount: number | null;
  vSol: number | null;
  wallet: string | null;
  signature: string;
};

export async function fetchMintTradeEvents(mint: string, limit = 80): Promise<MintTradeEvent[]> {
  const cap = Math.min(200, Math.max(10, limit));
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
    LIMIT ${sql.raw(String(cap))}
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

export type MintChartCandle = {
  t: string;
  open: number;
  high: number;
  low: number;
  close: number;
  buys: number;
  sells: number;
  buyVol: number;
  sellVol: number;
};

export async function fetchMintOHLCV(mint: string, hours = 6): Promise<MintChartCandle[]> {
  const h = Math.min(48, Math.max(1, Math.floor(hours)));
  const res = await getDb().execute(sql`
    WITH buckets AS (
      SELECT
        date_trunc('minute', ts) AS bucket,
        (array_agg(v_sol_after ORDER BY ts ASC) FILTER (WHERE v_sol_after IS NOT NULL))[1]::float8 AS open,
        MAX(v_sol_after)::float8 AS high,
        MIN(v_sol_after)::float8 AS low,
        (array_agg(v_sol_after ORDER BY ts DESC) FILTER (WHERE v_sol_after IS NOT NULL))[1]::float8 AS close,
        COUNT(*) FILTER (WHERE kind = 'buy')::int AS buys,
        COUNT(*) FILTER (WHERE kind = 'sell')::int AS sells,
        COALESCE(SUM(sol_amount) FILTER (WHERE kind = 'buy'), 0)::float8 AS buy_vol,
        COALESCE(SUM(sol_amount) FILTER (WHERE kind = 'sell'), 0)::float8 AS sell_vol
      FROM events
      WHERE mint = ${mint}
        AND ts > now() - (${sql.raw(String(h))} || ' hours')::interval
        AND kind IN ('buy', 'sell')
      GROUP BY 1
      ORDER BY 1
    )
    SELECT
      to_char(bucket, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS t,
      open, high, low, close, buys, sells, buy_vol, sell_vol
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
    buy_vol: number;
    sell_vol: number;
  };
  return (res as unknown as { rows: Raw[] }).rows.map((r) => ({
    t: r.t,
    open: r.open,
    high: r.high,
    low: r.low,
    close: r.close,
    buys: r.buys,
    sells: r.sells,
    buyVol: r.buy_vol,
    sellVol: r.sell_vol,
  }));
}
