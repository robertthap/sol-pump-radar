import type { PoolClient } from "pg";
import { getPool, paperPortfolio, paperPositions, paperSessions } from "@spr/db";
import { eq, inArray } from "drizzle-orm";
import { getRuntimeDb } from "@spr/db";

export type PortfolioRow = typeof paperPortfolio.$inferSelect;
export type PositionRow = typeof paperPositions.$inferSelect;
export type SessionRow = typeof paperSessions.$inferSelect;

/**
 * Idempotent boot: ensure exactly one paper_portfolio row + an active session.
 * Safe to call on every worker start.
 */
export async function ensurePortfolio(opts: { startSol: number }): Promise<{
  portfolio: PortfolioRow;
  session: SessionRow;
  created: boolean;
}> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query<{ id: number; session_id: string }>(
      "SELECT id, session_id::text AS session_id FROM paper_portfolio WHERE id = 1",
    );
    if (existing.rows.length > 0) {
      await client.query("COMMIT");
      const portfolio = await loadPortfolio();
      if (!portfolio) throw new Error("paper_portfolio row vanished after boot");
      const session = await loadSession(BigInt(existing.rows[0]!.session_id));
      if (!session) throw new Error("active paper_sessions row missing");
      return { portfolio, session, created: false };
    }

    const sessionRes = await client.query<{ id: string }>(
      `INSERT INTO paper_sessions (starting_balance_sol)
       VALUES ($1) RETURNING id::text AS id`,
      [opts.startSol],
    );
    const sessionId = BigInt(sessionRes.rows[0]!.id);

    await client.query(
      `INSERT INTO paper_portfolio
        (id, session_id, balance_sol, equity_sol, peak_equity_sol)
       VALUES (1, $1, $2, $2, $2)`,
      [sessionId.toString(), opts.startSol],
    );
    await client.query("COMMIT");

    const portfolio = await loadPortfolio();
    const session = await loadSession(sessionId);
    if (!portfolio || !session) throw new Error("portfolio/session insert verification failed");
    return { portfolio, session, created: true };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function loadPortfolio(): Promise<PortfolioRow | null> {
  const db = getRuntimeDb();
  const rows = await db.select().from(paperPortfolio).where(eq(paperPortfolio.id, 1));
  return rows[0] ?? null;
}

export async function loadSession(id: bigint): Promise<SessionRow | null> {
  const db = getRuntimeDb();
  const rows = await db.select().from(paperSessions).where(eq(paperSessions.id, id));
  return rows[0] ?? null;
}

export async function loadOpenPositions(sessionId?: bigint): Promise<PositionRow[]> {
  const db = getRuntimeDb();
  const all = await db
    .select()
    .from(paperPositions)
    .where(inArray(paperPositions.state, ["INTENT", "OPEN", "CLOSING"]));
  if (sessionId == null) return all;
  return all.filter((p) => p.sessionId === sessionId);
}

export async function withTx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
