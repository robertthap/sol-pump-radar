import { NextResponse } from "next/server";
import { bootDb } from "@/lib/db/client";
import { listLearnedRules } from "@/lib/db/repos/loss-learning";
import { queueWebCommand } from "@/lib/runtime/queue-command";
import { WebWriteOp } from "@/lib/runtime/web-writes";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  await bootDb();
  const rules = await listLearnedRules(60);
  return NextResponse.json({ rules });
}

type Body = { id: string; status: "applied" | "proposed" | "reverted" };
export async function PATCH(req: Request) {
  await bootDb();
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!body.id || !body.status) {
    return NextResponse.json({ error: "missing_id_or_status" }, { status: 400 });
  }
  if (!["applied", "proposed", "reverted"].includes(body.status)) {
    return NextResponse.json({ error: "invalid_status" }, { status: 400 });
  }
  try {
    BigInt(body.id);
  } catch {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
  const { correlationId } = await queueWebCommand(
    WebWriteOp.LEARNING_RULE_STATUS,
    "LEARNING_RULE_STATUS_REQUESTED",
    { id: body.id, status: body.status, strategy_id: "operator" },
    "learn-rule",
  );
  return NextResponse.json({ ok: true, queued: true, correlationId }, { status: 202 });
}
