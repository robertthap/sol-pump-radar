import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { bootDb } from "@/lib/db/client";
import { executeWebMutation, WebWriteOp } from "@/lib/runtime/web-writes";
import { getUiTradingMode } from "@/lib/db/repos/trading-mode";
import { env, isLiveAllowed } from "@/lib/env";
import { resolvePumpTradeMint } from "@/lib/pump/resolve-price";
import { resolveTradeSessionId } from "@/lib/runtime/trade-session-id";
import { logger } from "@/lib/log";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const log = logger("api:trade:quick-buy");

/**
 * Queue-only live-trade intent. Web cannot sign; web cannot execute. The worker
 * picks up LIVE_TRADE_INTENT from domain_events, validates against its own
 * unlocked vault, and submits the tx. Callers poll /api/trade/status/[id].
 */
export async function POST(req: NextRequest) {
  await bootDb();
  const e = env();
  if (e.RUNTIME_PROFILE === "paper_safe") {
    return NextResponse.json(
      { error: "live_disabled_paper_safe", hint: "Set RUNTIME_PROFILE=live + LIVE_CONFIRM" },
      { status: 409 },
    );
  }
  if (!isLiveAllowed() && e.LIVE_DRY_RUN !== "on") {
    return NextResponse.json({ error: "live_not_confirmed" }, { status: 409 });
  }
  if ((await getUiTradingMode()) === "demo") {
    return NextResponse.json(
      { error: "not_in_real_mode", hint: "Switch to Real mode or use POST /api/trade/demo" },
      { status: 409 },
    );
  }

  let body: { mint?: unknown; sizeSol?: unknown; vSol?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const mint = typeof body.mint === "string" ? body.mint.trim() : "";
  const sizeSol = typeof body.sizeSol === "number" ? body.sizeSol : Number(body.sizeSol);
  const hintVSol = typeof body.vSol === "number" ? body.vSol : Number(body.vSol);
  if (!mint || mint.length < 32) {
    return NextResponse.json({ error: "invalid_mint" }, { status: 400 });
  }
  if (!Number.isFinite(sizeSol) || sizeSol <= 0) {
    return NextResponse.json({ error: "invalid_size" }, { status: 400 });
  }
  if (sizeSol > e.LIVE_MAX_PER_TRADE_SOL) {
    return NextResponse.json(
      { error: "size_over_cap", hint: `max ${e.LIVE_MAX_PER_TRADE_SOL} SOL per trade` },
      { status: 400 },
    );
  }

  const resolved = await resolvePumpTradeMint(
    mint,
    Number.isFinite(hintVSol) && hintVSol > 0 ? hintVSol : null,
  );
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.error }, { status: 400 });
  }

  const correlationId = `live-buy-${randomUUID()}`;
  const sessionId = await resolveTradeSessionId();
  try {
    const eventId = await executeWebMutation(WebWriteOp.LIVE_TRADE_INTENT, async (client) => {
      const r = await client.query<{ id: string }>(
        `INSERT INTO domain_events (type, payload, dedupe_key, correlation_id)
         VALUES ('LIVE_TRADE_INTENT', $1::jsonb, $2, $3)
         RETURNING id::text AS id`,
        [
          JSON.stringify({
            side: "buy",
            mint,
            sizeSol,
            entryVSol: resolved.vSol,
            source: "quick-buy",
            strategy_id: "manual_live",
            ...(sessionId ? { session_id: sessionId } : {}),
            requestedAt: new Date().toISOString(),
          }),
          `live:intent:${correlationId}`,
          correlationId,
        ],
      );
      return r.rows[0]!.id;
    });
    log.info("queued live buy", { mint, sizeSol, correlationId });
    return NextResponse.json(
      {
        ok: true,
        queued: true,
        correlationId,
        eventId,
        statusUrl: `/api/trade/status/${correlationId}`,
      },
      { status: 202 },
    );
  } catch (e) {
    log.error("queue failed", { err: String(e) });
    return NextResponse.json({ error: "queue_failed", reason: String(e) }, { status: 500 });
  }
}
