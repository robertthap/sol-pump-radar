import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { bootDb } from "@/lib/db/client";
import { executeWebMutation, WebWriteOp } from "@/lib/runtime/web-writes";
import {
  fetchDemoAccount,
  getUiTradingMode,
  hasOpenDemoPosition,
} from "@/lib/db/repos/trading-mode";
import { resolveEntryVSol, resolvePumpTradeMint } from "@/lib/pump/resolve-price";
import { resolveTradeSessionId } from "@/lib/runtime/trade-session-id";
import { logger } from "@/lib/log";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const log = logger("api:trade:demo");

/**
 * Queue-only demo trade intent. Web validates and enqueues; worker executes
 * via paperOpen/paperClose in the paper-trade listener.
 */
export async function POST(req: Request) {
  await bootDb();
  const mode = await getUiTradingMode();
  if (mode !== "demo") {
    return NextResponse.json(
      { error: "not_in_demo_mode", hint: "Log off and pick Demo wallet on the home page" },
      { status: 409 },
    );
  }

  const sessionId = await resolveTradeSessionId();

  let body: { mint?: string; sizeSol?: number; side?: "buy" | "sell"; vSol?: number };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const mint = typeof body.mint === "string" ? body.mint.trim() : "";
  const side = body.side === "sell" ? "sell" : "buy";
  const hintVSol = typeof body.vSol === "number" ? body.vSol : null;
  if (!mint || mint.length < 32) {
    return NextResponse.json({ error: "invalid_mint" }, { status: 400 });
  }

  const resolved = await resolvePumpTradeMint(mint, hintVSol);
  let entryVSol: number | null = resolved.ok ? resolved.vSol : null;
  if (entryVSol == null || entryVSol <= 0) {
    entryVSol = await resolveEntryVSol(mint);
  }
  if (entryVSol == null || entryVSol <= 0) {
    const err = resolved.ok ? "no_price" : resolved.error;
    return NextResponse.json(
      {
        error: err,
        hint:
          err === "no_price" || err === "pump_fun_lookup_failed"
            ? "No bonding-curve price yet — wait a few seconds for ingest or try another token"
            : "This mint is not on pump.fun or has no tradable curve",
      },
      { status: 400 },
    );
  }

  if (side === "buy") {
    const sizeSol = Number(body.sizeSol);
    if (!Number.isFinite(sizeSol) || sizeSol <= 0) {
      return NextResponse.json({ error: "invalid_size" }, { status: 400 });
    }
    const demoBefore = await fetchDemoAccount();
    if (sizeSol > demoBefore.balanceSol) {
      return NextResponse.json(
        {
          error: "insufficient_demo_balance",
          balanceSol: demoBefore.balanceSol,
          requested: sizeSol,
        },
        { status: 400 },
      );
    }
    const existing = await hasOpenDemoPosition(mint);
    if (existing) {
      return NextResponse.json({ error: "already_have_open_demo_position" }, { status: 409 });
    }

    const correlationId = `paper-buy-${randomUUID()}`;
    try {
      const eventId = await executeWebMutation(WebWriteOp.PAPER_TRADE_INTENT, async (client) => {
        const r = await client.query<{ id: string }>(
          `INSERT INTO domain_events (type, payload, dedupe_key, correlation_id)
           VALUES ('PAPER_TRADE_INTENT', $1::jsonb, $2, $3)
           RETURNING id::text AS id`,
          [
            JSON.stringify({
              side: "buy",
              mint,
              sizeSol,
              entryVSol,
              source: "manual_demo_buy",
              strategy_id: "manual_demo",
              ...(sessionId ? { session_id: sessionId } : {}),
              requestedAt: new Date().toISOString(),
            }),
            `paper:intent:${correlationId}`,
            correlationId,
          ],
        );
        return r.rows[0]!.id;
      });
      log.info("queued demo buy", { mint, sizeSol, correlationId });
      return NextResponse.json(
        {
          ok: true,
          queued: true,
          side: "buy",
          correlationId,
          eventId,
          statusUrl: `/api/trade/status/${correlationId}`,
        },
        { status: 202 },
      );
    } catch (e) {
      return NextResponse.json({ error: "queue_failed", reason: String(e) }, { status: 500 });
    }
  }

  // sell — worker verifies open position
  const correlationId = `paper-sell-${randomUUID()}`;
  try {
    const eventId = await executeWebMutation(WebWriteOp.PAPER_TRADE_INTENT, async (client) => {
      const r = await client.query<{ id: string }>(
        `INSERT INTO domain_events (type, payload, dedupe_key, correlation_id)
         VALUES ('PAPER_TRADE_INTENT', $1::jsonb, $2, $3)
         RETURNING id::text AS id`,
        [
            JSON.stringify({
              side: "sell",
              mint,
              entryVSol,
              source: "manual_demo_sell",
              strategy_id: "manual_demo",
              ...(sessionId ? { session_id: sessionId } : {}),
              requestedAt: new Date().toISOString(),
            }),
          `paper:intent:${correlationId}`,
          correlationId,
        ],
      );
      return r.rows[0]!.id;
    });
    log.info("queued demo sell", { mint, correlationId });
    return NextResponse.json(
      {
        ok: true,
        queued: true,
        side: "sell",
        correlationId,
        eventId,
        statusUrl: `/api/trade/status/${correlationId}`,
      },
      { status: 202 },
    );
  } catch (e) {
    return NextResponse.json({ error: "queue_failed", reason: String(e) }, { status: 500 });
  }
}
