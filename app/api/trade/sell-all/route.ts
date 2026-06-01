import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { bootDb } from "@/lib/db/client";
import { executeWebMutation, WebWriteOp } from "@/lib/runtime/web-writes";
import { getUiTradingMode } from "@/lib/db/repos/trading-mode";
import { fetchOpenLivePositions } from "@/lib/db/repos/live-trades";
import { fetchSellableOpenPaperPositions } from "@/lib/paper/sellable-positions";
import { resolveTradeSessionId } from "@/lib/runtime/trade-session-id";
import { env, isLiveAllowed } from "@/lib/env";
import { getActiveSession, getLatestSession } from "@/lib/db/repos/auto-sessions";
import { logger } from "@/lib/log";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const log = logger("api:trade:sell-all");

type Body = {
  scope?: "all" | "auto";
  sessionId?: string;
};

/** Close all open holdings — demo paper bulk or live per-mint queue. */
export async function POST(req: Request) {
  await bootDb();
  let body: Body = {};
  try {
    body = (await req.json()) as Body;
  } catch {
    /* empty body ok */
  }

  const scope = body.scope === "auto" ? "auto" : "all";
  const uiMode = await getUiTradingMode();

  if (uiMode === "demo") {
    let sessionId: string | null =
      typeof body.sessionId === "string" && body.sessionId.trim() ? body.sessionId.trim() : null;
    if (scope === "auto" && !sessionId) {
      const active = await getActiveSession();
      const latest = active ?? (await getLatestSession());
      sessionId = latest?.id ?? null;
    }
    if (scope === "auto" && !sessionId) {
      return NextResponse.json({ error: "no_auto_session" }, { status: 404 });
    }

    const open = await fetchSellableOpenPaperPositions({
      sessionId: scope === "auto" ? sessionId : null,
    });
    if (open.length === 0) {
      return NextResponse.json({
        ok: true,
        queued: false,
        closedCount: 0,
        message: "no_open_positions",
      });
    }

    const correlationId = `paper-sell-all-${randomUUID()}`;
    try {
      const eventId = await executeWebMutation(WebWriteOp.PAPER_TRADE_INTENT, async (client) => {
        const r = await client.query<{ id: string }>(
          `INSERT INTO domain_events (type, payload, dedupe_key, correlation_id)
           VALUES ('PAPER_TRADE_INTENT', $1::jsonb, $2, $3)
           RETURNING id::text AS id`,
          [
            JSON.stringify({
              side: "sell_all",
              scope,
              source: "manual_sell_all",
              strategy_id: "manual_demo",
              ...(scope === "auto" && sessionId ? { session_id: sessionId } : {}),
              requestedAt: new Date().toISOString(),
            }),
            `paper:sell-all:${correlationId}`,
            correlationId,
          ],
        );
        return r.rows[0]!.id;
      });
      log.info("queued paper sell-all", { scope, count: open.length, correlationId });
      return NextResponse.json(
        {
          ok: true,
          queued: true,
          mode: "demo",
          openCount: open.length,
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

  const e = env();
  if (e.RUNTIME_PROFILE === "paper_safe") {
    return NextResponse.json({ error: "live_disabled_paper_safe" }, { status: 409 });
  }
  if (!isLiveAllowed() && e.LIVE_DRY_RUN !== "on") {
    return NextResponse.json({ error: "live_not_confirmed" }, { status: 409 });
  }

  let liveRows = await fetchOpenLivePositions();
  if (scope === "auto") {
    let sessionId =
      typeof body.sessionId === "string" && body.sessionId.trim() ? body.sessionId.trim() : null;
    if (!sessionId) {
      const active = await getActiveSession();
      const latest = active ?? (await getLatestSession());
      sessionId = latest?.id ?? null;
    }
    if (sessionId) {
      liveRows = liveRows.filter((r) => r.sessionId === sessionId);
    }
  }

  if (liveRows.length === 0) {
    return NextResponse.json({
      ok: true,
      queued: false,
      closedCount: 0,
      message: "no_open_positions",
    });
  }

  const tradeSessionId = await resolveTradeSessionId();
  const correlationIds: string[] = [];
  const positionIds = liveRows.map((r) => r.id);
  try {
    await executeWebMutation(WebWriteOp.LIVE_SELL_INTENT, async (client) => {
      await client.query(
        `UPDATE live_trades SET status = 'pending_close'
         WHERE id = ANY($1::bigint[]) AND status = 'open' AND closed_at IS NULL`,
        [positionIds.map((id) => id.toString())],
      );
      for (const row of liveRows) {
        const correlationId = `live-sell-all-${randomUUID()}`;
        correlationIds.push(correlationId);
        await client.query(
          `INSERT INTO domain_events (type, payload, dedupe_key, correlation_id)
           VALUES ('LIVE_TRADE_INTENT', $1::jsonb, $2, $3)`,
          [
            JSON.stringify({
              side: "sell",
              mint: row.mint,
              percent: 100,
              entryVSol: row.entryPrice,
              source: "sell-all",
              strategy_id: "manual_live",
              liveTradeId: row.id.toString(),
              ...(tradeSessionId ? { session_id: tradeSessionId } : {}),
              requestedAt: new Date().toISOString(),
            }),
            `live:intent:${correlationId}`,
            correlationId,
          ],
        );
      }
      return correlationIds[0] ?? "sell-all";
    });
    log.info("queued live sell-all", { count: liveRows.length });
    return NextResponse.json(
      {
        ok: true,
        queued: true,
        mode: "live",
        openCount: liveRows.length,
        correlationIds,
      },
      { status: 202 },
    );
  } catch (err) {
    return NextResponse.json({ error: "queue_failed", reason: String(err) }, { status: 500 });
  }
}
