import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { executeWebMutation, WebWriteOp } from "@/lib/runtime/web-writes";
import { bootDb } from "@/lib/db/client";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/paper/reset — request a portfolio reset.
 *
 * The web route NEVER directly mutates portfolio state. It appends a
 * PAPER_RESET_REQUESTED domain event through the web-write gate; the worker
 * picks it up and performs the transactional reset.
 */
export async function POST(req: Request) {
  await bootDb();
  let body: { reason?: string; startSol?: number } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    /* empty body is fine */
  }
  const reason = (body.reason ?? "user reset").slice(0, 256);
  const startSol = typeof body.startSol === "number" && body.startSol > 0 ? body.startSol : undefined;
  const correlationId = `paper-reset-${randomUUID()}`;

  try {
    const id = await executeWebMutation(WebWriteOp.PAPER_RESET_REQUEST, async (client) => {
      const r = await client.query<{ id: string }>(
        `INSERT INTO domain_events (type, payload, dedupe_key, correlation_id)
         VALUES ('PAPER_RESET_REQUESTED', $1::jsonb, $2, $3)
         RETURNING id::text AS id`,
        [JSON.stringify({ reason, startSol }), `paper:reset-req:${correlationId}`, correlationId],
      );
      return r.rows[0]!.id;
    });
    return NextResponse.json({
      ok: true,
      eventId: id,
      correlationId,
      note: "queued — worker will apply within ~2 seconds",
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
