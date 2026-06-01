import { NextResponse } from "next/server";
import { bootDb } from "@/lib/db/client";
import { queueWebCommand } from "@/lib/runtime/queue-command";
import { WebWriteOp } from "@/lib/runtime/web-writes";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  await bootDb();
  let body: { reason?: string } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    /* empty */
  }
  const { correlationId } = await queueWebCommand(
    WebWriteOp.AUTO_SESSION_STOP,
    "AUTO_SESSION_STOP_REQUESTED",
    { reason: body.reason ?? "user requested", strategy_id: "auto_trader" },
    "auto-stop",
  );
  return NextResponse.json(
    { ok: true, queued: true, correlationId, statusUrl: `/api/trade/status/${correlationId}` },
    { status: 202 },
  );
}
