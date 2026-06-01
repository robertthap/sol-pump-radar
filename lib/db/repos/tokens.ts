import "server-only";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { tokens } from "@/lib/db/schema";
import type { ParsedCreateEvent } from "@/lib/pump/parser";
import { logger } from "@/lib/log";

const log = logger("repo:tokens");

export async function upsertNewTokens(creates: ParsedCreateEvent[]): Promise<number> {
  if (creates.length === 0) return 0;
  const rows = creates.map((c) => ({
    mint: c.mint,
    firstSeenSlot: c.slot,
    creator: c.wallet,
    name: c.name,
    symbol: c.symbol,
    metadataUri: c.uri,
    status: "active",
    decimals: 6,
  }));
  try {
    await getDb()
      .insert(tokens)
      .values(rows)
      .onConflictDoNothing({ target: tokens.mint });
    return rows.length;
  } catch (e) {
    log.warn("token upsert failed", { err: String(e) });
    return 0;
  }
}

export type TokenSummaryDto = {
  mint: string;
  symbol: string | null;
  name: string | null;
  creator: string | null;
  createdAt: string;
  status: string;
  recentEvents: number;
};

export async function fetchTopActiveTokens(limit = 10): Promise<TokenSummaryDto[]> {
  const res = await getDb().execute(sql`
    SELECT
      t.mint AS mint,
      t.symbol AS symbol,
      t.name AS name,
      t.creator AS creator,
      t.created_at AS created_at,
      t.status AS status,
      COALESCE(e.cnt, 0)::int AS recent_events
    FROM tokens t
    LEFT JOIN (
      SELECT mint, count(*) AS cnt
      FROM events
      WHERE ts > now() - interval '5 minutes'
      GROUP BY mint
    ) e ON e.mint = t.mint
    ORDER BY e.cnt DESC NULLS LAST, t.created_at DESC
    LIMIT ${sql.raw(String(limit))}
  `);
  type Row = {
    mint: string;
    symbol: string | null;
    name: string | null;
    creator: string | null;
    created_at: Date | string;
    status: string;
    recent_events: number;
  };
  const rows = (res as unknown as { rows: Row[] }).rows;
  return rows.map((r) => ({
    mint: r.mint,
    symbol: r.symbol,
    name: r.name,
    creator: r.creator,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    status: r.status,
    recentEvents: r.recent_events,
  }));
}
