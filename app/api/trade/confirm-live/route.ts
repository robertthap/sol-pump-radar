import { NextResponse } from "next/server";
import { bootDb } from "@/lib/db/client";
import { getUiTradingMode } from "@/lib/db/repos/trading-mode";
import type { LiveTradeRoute } from "@/lib/db/repos/live-trades";
import { env } from "@/lib/env";
import { withRoutePerf } from "@/lib/runtime/with-route-perf";
import { queueWebCommand } from "@/lib/runtime/queue-command";
import { WebWriteOp } from "@/lib/runtime/web-writes";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ROUTES = new Set<LiveTradeRoute>(["jupiter", "pumpportal", "blocked"]);

/**
 * Queue Phantom post-sign record — worker writes live ledger (audited exception).
 * Browser signs; worker records. See phantom-live-listener.ts.
 */
export const POST = withRoutePerf(async (req: Request) => {
  await bootDb();
  if ((await getUiTradingMode()) === "demo") {
    return NextResponse.json({ error: "not_in_real_mode" }, { status: 409 });
  }
  if (env().LIVE_EXECUTION !== "on") {
    return NextResponse.json({ error: "live_disabled" }, { status: 409 });
  }

  let body: {
    side?: unknown;
    mint?: unknown;
    sizeSol?: unknown;
    percent?: unknown;
    signature?: unknown;
    route?: unknown;
    entryVSol?: unknown;
    publicKey?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const side = body.side === "buy" || body.side === "sell" ? body.side : null;
  const mint = typeof body.mint === "string" ? body.mint.trim() : "";
  const signature = typeof body.signature === "string" ? body.signature.trim() : "";
  const publicKey = typeof body.publicKey === "string" ? body.publicKey.trim() : "";
  const routeRaw = typeof body.route === "string" ? body.route.trim() : "";
  const route = ROUTES.has(routeRaw as LiveTradeRoute) ? (routeRaw as LiveTradeRoute) : null;

  if (!side || !mint || mint.length < 32) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  if (!signature || signature.length < 32) {
    return NextResponse.json({ error: "invalid_signature" }, { status: 400 });
  }
  if (!publicKey || publicKey.length < 32) {
    return NextResponse.json({ error: "invalid_public_key" }, { status: 400 });
  }
  if (!route || route === "blocked") {
    return NextResponse.json({ error: "invalid_route" }, { status: 400 });
  }

  const payload: Record<string, unknown> = {
    side,
    mint,
    signature,
    route,
    publicKey,
    strategy_id: "phantom_live",
  };
  if (side === "buy") {
    const sizeSol = typeof body.sizeSol === "number" ? body.sizeSol : Number(body.sizeSol);
    const entryVSol =
      typeof body.entryVSol === "number"
        ? body.entryVSol
        : body.entryVSol == null
          ? null
          : Number(body.entryVSol);
    if (!Number.isFinite(sizeSol) || sizeSol <= 0) {
      return NextResponse.json({ error: "invalid_size" }, { status: 400 });
    }
    payload.sizeSol = sizeSol;
    if (entryVSol != null && Number.isFinite(entryVSol)) payload.entryVSol = entryVSol;
  } else {
    const percent =
      typeof body.percent === "number"
        ? body.percent
        : body.percent == null
          ? 100
          : Number(body.percent);
    if (!Number.isFinite(percent) || percent <= 0 || percent > 100) {
      return NextResponse.json({ error: "invalid_percent" }, { status: 400 });
    }
    payload.percent = percent;
  }

  const { correlationId } = await queueWebCommand(
    WebWriteOp.PHANTOM_LIVE_RECORD,
    "PHANTOM_LIVE_RECORD_REQUESTED",
    payload,
    "phantom-live",
  );
  return NextResponse.json(
    { ok: true, queued: true, correlationId, statusUrl: `/api/trade/status/${correlationId}` },
    { status: 202 },
  );
});
