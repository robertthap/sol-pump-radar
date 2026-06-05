import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { bootDb, getDb } from "@/lib/db/client";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Lean price series (vSol over time) for the trade-marker chart.
 *
 * LIMIT-based, NOT now()-windowed: the host clock jumps when the machine sleeps,
 * so a `now() - interval` window silently drops a position's history. We take the
 * last N trade events for the mint instead — always covers the active trade window.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ mint: string }> },
) {
  const { mint } = await params;
  if (!mint || mint.length < 32) {
    return NextResponse.json({ error: "invalid_mint" }, { status: 400 });
  }
  const url = new URL(req.url);
  const limit = Math.min(2000, Math.max(50, Number(url.searchParams.get("limit") ?? 800)));
  await bootDb();
  try {
    const res = await getDb().execute(sql`
      SELECT to_char(ts, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS t, v_sol_after::float8 AS v_sol
      FROM (
        SELECT ts, v_sol_after
        FROM events
        WHERE mint = ${mint}
          AND v_sol_after IS NOT NULL
          AND v_sol_after > 0
          AND kind IN ('buy', 'sell')
        ORDER BY ts DESC
        LIMIT ${sql.raw(String(limit))}
      ) recent
      ORDER BY ts ASC
    `);
    const rows = (res as unknown as { rows: Array<{ t: string; v_sol: number }> }).rows;
    const points = rows.map((r) => ({ t: r.t, vSol: r.v_sol }));
    return NextResponse.json({ points });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
