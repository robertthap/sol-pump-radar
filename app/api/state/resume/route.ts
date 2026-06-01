import { NextResponse } from "next/server";
import { bootDb } from "@/lib/db/client";
import { queueWebCommand } from "@/lib/runtime/queue-command";
import { WebWriteOp } from "@/lib/runtime/web-writes";

export const dynamic = "force-dynamic";

export async function POST() {
  await bootDb();
  const { correlationId } = await queueWebCommand(
    WebWriteOp.CIRCUIT_BREAKER,
    "CIRCUIT_BREAKER_REQUESTED",
    { action: "resume", reason: "manual resume from dashboard", strategy_id: "operator" },
    "cb-resume",
  );
  return NextResponse.json({ ok: true, queued: true, correlationId }, { status: 202 });
}
