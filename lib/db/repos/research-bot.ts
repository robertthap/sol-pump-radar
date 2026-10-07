import "server-only";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import type { TapeEvent, StrategyId } from "@/lib/strategies/catalog";

export type ResearchPosition = { id: string; mint: string; quantity: number; notional: number; entry: number; features: Record<string, unknown> };
export async function researchPositions(): Promise<ResearchPosition[]> {
  const res = await getDb().execute(sql`SELECT id::text, mint, quantity::float8,notional_sol::float8 AS notional,entry_price::float8 AS entry,entry_features AS features
    FROM paper_positions WHERE state='OPEN' AND entry_features->>'research_strategy' IS NOT NULL`);
  return (res as unknown as { rows: ResearchPosition[] }).rows;
}

/**
 * Recent decision tape plus a bounded management window for open positions.
 *
 * Loading the full history of every mint active in the last 20 seconds made a
 * hot market explode past 150k rows and aborted every auto-trader tick. The
 * strategy only evaluates entry episodes from the last 20 seconds, while its
 * longest research position holds for 10 minutes, so wider history is stale
 * for both decisions and position management.
 */
export async function researchLiveEvents(openMints: string[], includeEntries: boolean): Promise<TapeEvent[]> {
  // Postgres array literals, built here rather than interpolated. A JS array
  // dropped into sql`` expands to a record: `()::text[]` with no open position
  // is a syntax error and `('a','b')::text[]` is an invalid record cast, so this
  // query threw on EVERY tick and the research lane never saw one event.
  // Measured 2026-09-27: auto-tick failed once a second, research_episodes empty.
  const mints = openMints.map((m) => `'${m.replace(/'/g, "''")}'`).join(",");
  const entries = includeEntries ? "true" : "false";
  const result = await getDb().execute(sql`
    SELECT e.id::float8,e.mint,extract(epoch FROM e.ts)::float8 AS ts,e.slot::float8,e.kind,e.venue,e.pool,e.wallet,e.side,
      e.sol_amount::float8 AS sol,e.token_amount::float8 AS tokens,e.v_sol_after::float8 AS "vSol"
    FROM events e
    WHERE e.kind IN ('buy','sell','migrate')
      AND (
        -- Curve Ladder's frozen entry rule needs a complete 120-second progress
        -- window. Keep a small scheduling margin while fromTs still limits
        -- decisions to the current 20-second live window.
        (${sql.raw(entries)} AND e.ts >= now() - interval '150 seconds')
        OR (
          e.mint = ANY(ARRAY[${sql.raw(mints)}]::text[])
          AND e.ts >= now() - interval '15 minutes'
        )
      )
    ORDER BY e.slot,e.id LIMIT 150001
  `);
  const rows = (result as unknown as { rows: TapeEvent[] }).rows;
  if (rows.length > 150000) throw new Error("Research feed batch exceeds 150,000 events; entries paused rather than using incomplete histories");
  return rows;
}
export async function recordResearchEpisode(sessionId: string, e: { id: string; mint: string; decisionTs: number; features: object }, strategy: StrategyId, status: string, reason: string) {
  const result = await getDb().execute(sql`INSERT INTO research_episodes(session_id,episode_key,mint,strategy,decision_ts,status,reason,features)
    VALUES (${sessionId}::bigint,${e.id},${e.mint},${strategy},to_timestamp(${e.decisionTs}),${status},${reason},${JSON.stringify(e.features)}::jsonb)
    ON CONFLICT (session_id,episode_key) DO NOTHING RETURNING episode_key`);
  return (result as unknown as { rows: unknown[] }).rows.length > 0;
}
export async function episodeStatuses(sessionId: string): Promise<Map<string,string>> {
  const result = await getDb().execute(sql`SELECT episode_key,status FROM research_episodes WHERE session_id=${sessionId}::bigint`);
  return new Map((result as unknown as { rows: Array<{ episode_key: string; status: string }> }).rows.map((r) => [r.episode_key,r.status]));
}
/**
 * Coerce a value to a bigint id, or null if it is not one.
 *
 * Callers build these from JSONB (`entry_features`), where a key may simply be
 * absent. `String(undefined)` yields the literal STRING "undefined", which
 * Postgres rejects with `invalid input syntax for type bigint: "undefined"` and
 * which aborts the whole surrounding tick. The value `undefined` is NOT the
 * same failure — it binds as a missing parameter and raises a syntax error —
 * so the stringified forms are what this exists to catch.
 *
 * Kept as text, never Number(): bigserial can exceed 2^53, and coercing through
 * a double would silently change the id.
 */
export function bigintIdOrNull(value: unknown): string | null {
  if (typeof value === "bigint") return value > 0n ? value.toString() : null;
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
  }
  if (typeof value !== "string") return null;
  const text = value.trim();
  // Digits only: rejects "undefined", "null", "NaN", "", "12.5", "-3", "1e3",
  // "0x1f" and "12abc" without a round trip through Number.
  if (!/^[0-9]+$/.test(text)) return null;
  return /^0+$/.test(text) ? null : text.replace(/^0+/, "");
}

export async function finishResearchEpisode(sessionId: string, key: string, status: string, reason: string) {
  const id = bigintIdOrNull(sessionId);
  // No usable session id means there is no episode row this could match. Doing
  // nothing is correct; sending "undefined" aborted the caller's entire tick.
  if (id == null) return;
  await getDb().execute(sql`UPDATE research_episodes SET status=${status},reason=${reason},updated_at=now() WHERE session_id=${id}::bigint AND episode_key=${key}`);
}
export async function markResearchPosition(id: string, features: Record<string,unknown>, price: number | null, pnl: number | null) {
  await getDb().execute(sql`UPDATE paper_positions SET current_price=${price},unrealized_pnl_sol=${pnl ?? 0},
    entry_features=entry_features || ${JSON.stringify({ ...features, research_mark_pnl: pnl, price_at_ms: pnl == null ? 0 : Date.now() })}::jsonb
    WHERE id=${id}::bigint AND state='OPEN'`);
  // Keep the wallet card and risk ledger on the same mark as the position. The
  // periodic MTM lane remains reconciliation, not the source of truth for a
  // research tick that has already completed.
  await getDb().execute(sql`UPDATE paper_portfolio SET
    unrealized_pnl_sol=(SELECT COALESCE(sum(unrealized_pnl_sol),0) FROM paper_positions WHERE state='OPEN'),
    equity_sol=balance_sol+(SELECT COALESCE(sum(notional_sol+COALESCE(unrealized_pnl_sol,0)),0) FROM paper_positions WHERE state='OPEN'),
    peak_equity_sol=GREATEST(peak_equity_sol,balance_sol+(SELECT COALESCE(sum(notional_sol+COALESCE(unrealized_pnl_sol,0)),0) FROM paper_positions WHERE state='OPEN')),
    updated_at=now() WHERE id=1`);
}
export async function researchBotStatus(sessionId: string) {
  const res = await getDb().execute(sql`SELECT status,count(*)::int AS count FROM research_episodes WHERE session_id=${sessionId}::bigint GROUP BY status`);
  const recent = await getDb().execute(sql`SELECT r.episode_key AS id,r.mint,t.symbol,t.name,r.strategy,r.status,r.reason,r.features,r.decision_ts AS ts
    FROM research_episodes r LEFT JOIN tokens t ON t.mint=r.mint
    WHERE r.session_id=${sessionId}::bigint ORDER BY r.updated_at DESC LIMIT 12`);
  const performance = await getDb().execute(sql`SELECT count(*) FILTER (WHERE state='CLOSED')::int AS closed,
    count(*) FILTER (WHERE state='CLOSED' AND realized_pnl_sol>0)::int AS wins,
    count(*) FILTER (WHERE state='OPEN' AND entry_features->>'research_status'='CENSORED')::int AS censored
    FROM paper_positions WHERE entry_features->>'session_id'=${sessionId} AND entry_features->>'research_strategy' IS NOT NULL`);
  return { counts: (res as unknown as { rows: Array<{status:string;count:number}> }).rows,
    recent: (recent as unknown as { rows: Array<{id:string;mint:string;symbol:string|null;name:string|null;strategy:string;status:string;reason:string;features:Record<string,unknown>;ts:string}> }).rows,
    performance: (performance as unknown as { rows: Array<{closed:number;wins:number;censored:number}> }).rows[0] };
}
