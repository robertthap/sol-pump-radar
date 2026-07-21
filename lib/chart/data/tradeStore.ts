import "server-only";

import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import type { ChartTimeframe, DexQuoteRow, StreamStateRow, Trade } from "@/lib/chart/types";
import type { RawTradeInput } from "@/lib/chart/data/priceResolver";

type EventRow = {
  id: string;
  signature: string;
  mint?: string;
  ts: Date | string;
  kind: string;
  wallet: string | null;
  sol_amount: number | null;
  v_sol_after: number | null;
};

function sideFromKind(kind: string): "buy" | "sell" {
  return kind === "sell" ? "sell" : "buy";
}

export function mapEventRow(row: EventRow, mint: string): RawTradeInput {
  const ts = row.ts instanceof Date ? row.ts : new Date(row.ts);
  return {
    token: mint,
    wallet: row.wallet ?? "",
    side: sideFromKind(row.kind),
    amount: row.sol_amount ?? 0,
    timestamp: ts.getTime(),
    txHash: row.signature,
    tradeId: row.id,
    vSolAfter: row.v_sol_after,
  };
}

export async function fetchFirstTradeTs(mint: string): Promise<number | null> {
  const res = await getDb().execute(sql`
    SELECT ts FROM events
    WHERE mint = ${mint} AND kind IN ('buy', 'sell')
    ORDER BY id ASC
    LIMIT 1
  `);
  const row = (res as unknown as { rows: { ts: Date }[] }).rows[0];
  if (!row) return null;
  return new Date(row.ts).getTime();
}

/** On-chain migrate event timestamp, if indexed. */
export async function fetchMigrateTs(mint: string): Promise<number | null> {
  const res = await getDb().execute(sql`
    SELECT ts FROM events
    WHERE mint = ${mint} AND kind = 'migrate'
    ORDER BY id ASC
    LIMIT 1
  `);
  const row = (res as unknown as { rows: { ts: Date }[] }).rows[0];
  if (!row) return null;
  return new Date(row.ts).getTime();
}

export async function fetchTrades(
  mint: string,
  opts: { afterId?: string; beforeId?: string; limit?: number } = {},
): Promise<RawTradeInput[]> {
  const limit = Math.min(2000, Math.max(1, opts.limit ?? 500));
  const afterId = opts.afterId ?? "0";
  const beforeId = opts.beforeId;

  let res;
  if (beforeId) {
    res = await getDb().execute(sql`
      SELECT id::text, signature, ts, kind, wallet, sol_amount::float8 AS sol_amount,
             v_sol_after::float8 AS v_sol_after
      FROM events
      WHERE mint = ${mint}
        AND kind IN ('buy', 'sell')
        AND id < ${beforeId}::bigint
      ORDER BY id DESC
      LIMIT ${sql.raw(String(limit))}
    `);
    const rows = (res as unknown as { rows: EventRow[] }).rows.reverse();
    return rows.map((r) => mapEventRow(r, mint));
  }

  res = await getDb().execute(sql`
    SELECT id::text, signature, ts, kind, wallet, sol_amount::float8 AS sol_amount,
           v_sol_after::float8 AS v_sol_after
    FROM events
    WHERE mint = ${mint}
      AND kind IN ('buy', 'sell')
      AND id > ${afterId}::bigint
    ORDER BY id ASC
    LIMIT ${sql.raw(String(limit))}
  `);
  return (res as unknown as { rows: EventRow[] }).rows.map((r) => mapEventRow(r, mint));
}

export async function fetchTradesBySignatures(
  signatures: string[],
): Promise<Map<string, RawTradeInput>> {
  const uniq = [...new Set(signatures.filter(Boolean))];
  if (!uniq.length) return new Map();
  const res = await getDb().execute(sql`
    SELECT id::text, signature, mint, ts, kind, wallet,
           sol_amount::float8 AS sol_amount, v_sol_after::float8 AS v_sol_after
    FROM events
    WHERE signature = ANY(${uniq})
      AND kind IN ('buy', 'sell')
  `);
  const out = new Map<string, RawTradeInput>();
  for (const r of (res as unknown as { rows: EventRow[] }).rows) {
    if (!r.mint) continue;
    out.set(r.signature, mapEventRow(r, r.mint));
  }
  return out;
}

export async function fetchStreamState(mint: string): Promise<StreamStateRow | null> {
  const res = await getDb().execute(sql`
    SELECT mint, epoch, last_trade_id, last_seq, graduation_at, regime
    FROM chart_stream_state WHERE mint = ${mint}
  `);
  const row = (res as unknown as {
    rows: Array<{
      mint: string;
      epoch: number;
      last_trade_id: string;
      last_seq: number;
      graduation_at: Date | null;
      regime: string;
    }>;
  }).rows[0];
  if (!row) return null;
  return {
    mint: row.mint,
    epoch: row.epoch,
    lastTradeId: BigInt(row.last_trade_id),
    lastSeq: row.last_seq,
    graduationAt: row.graduation_at,
    regime: row.regime === "dex" ? "dex" : "bonding_curve",
  };
}

export async function upsertStreamState(state: StreamStateRow): Promise<void> {
  await getDb().execute(sql`
    INSERT INTO chart_stream_state (mint, epoch, last_trade_id, last_seq, graduation_at, regime, updated_at)
    VALUES (
      ${state.mint},
      ${state.epoch},
      ${state.lastTradeId.toString()}::bigint,
      ${state.lastSeq},
      ${state.graduationAt},
      ${state.regime},
      now()
    )
    ON CONFLICT (mint) DO UPDATE SET
      epoch = EXCLUDED.epoch,
      last_trade_id = EXCLUDED.last_trade_id,
      last_seq = EXCLUDED.last_seq,
      graduation_at = COALESCE(chart_stream_state.graduation_at, EXCLUDED.graduation_at),
      regime = EXCLUDED.regime,
      updated_at = now()
  `);
}

export async function fetchDexQuotes(mint: string, limit = 200): Promise<DexQuoteRow[]> {
  const res = await getDb().execute(sql`
    SELECT mint, ts, price_usd::float8 AS price_usd, mcap_usd::float8 AS mcap_usd, source
    FROM mint_dex_quotes
    WHERE mint = ${mint}
    ORDER BY ts DESC
    LIMIT ${sql.raw(String(limit))}
  `);
  const rows = (res as unknown as {
    rows: Array<{ mint: string; ts: Date; price_usd: number; mcap_usd: number | null; source: string }>;
  }).rows;
  return rows.reverse().map((r) => ({
    mint: r.mint,
    ts: new Date(r.ts),
    priceUsd: r.price_usd,
    mcapUsd: r.mcap_usd,
    source: r.source,
  }));
}

export async function insertDexQuote(opts: {
  mint: string;
  priceUsd: number;
  mcapUsd?: number | null;
  source?: string;
}): Promise<void> {
  await getDb().execute(sql`
    INSERT INTO mint_dex_quotes (mint, ts, price_usd, mcap_usd, source)
    VALUES (${opts.mint}, now(), ${opts.priceUsd}, ${opts.mcapUsd ?? null}, ${opts.source ?? "dexscreener"})
    ON CONFLICT (mint, ts, source) DO UPDATE SET
      price_usd = EXCLUDED.price_usd,
      mcap_usd = EXCLUDED.mcap_usd
  `);
}

export async function saveCheckpoint(opts: {
  mint: string;
  tf: ChartTimeframe;
  epoch: number;
  lastTradeId: bigint;
  candlesJson: unknown;
  checksum: string | null;
}): Promise<void> {
  await getDb().execute(sql`
    INSERT INTO chart_candle_checkpoints (mint, tf, epoch, last_trade_id, candles_json, checksum, updated_at)
    VALUES (
      ${opts.mint},
      ${opts.tf},
      ${opts.epoch},
      ${opts.lastTradeId.toString()}::bigint,
      ${JSON.stringify(opts.candlesJson)}::jsonb,
      ${opts.checksum},
      now()
    )
    ON CONFLICT (mint, tf) DO UPDATE SET
      epoch = EXCLUDED.epoch,
      last_trade_id = EXCLUDED.last_trade_id,
      candles_json = EXCLUDED.candles_json,
      checksum = EXCLUDED.checksum,
      updated_at = now()
  `);
}

export async function loadCheckpoint(
  mint: string,
  tf: ChartTimeframe,
): Promise<{ candles: import("@/lib/chart/types").Candle[]; lastTradeId: bigint; epoch: number } | null> {
  const res = await getDb().execute(sql`
    SELECT epoch, last_trade_id, candles_json
    FROM chart_candle_checkpoints
    WHERE mint = ${mint} AND tf = ${tf}
  `);
  const row = (res as unknown as {
    rows: Array<{ epoch: number; last_trade_id: string; candles_json: import("@/lib/chart/types").Candle[] }>;
  }).rows[0];
  if (!row) return null;
  return {
    epoch: row.epoch,
    lastTradeId: BigInt(row.last_trade_id),
    candles: row.candles_json ?? [],
  };
}

export type { Trade };
