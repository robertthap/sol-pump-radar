import { NextResponse } from "next/server";
import { bootDb } from "@/lib/db/client";
import { getEffectiveTradeLimits } from "@/lib/db/repos/settings";
import { env } from "@/lib/env";
import { queueWebCommand } from "@/lib/runtime/queue-command";
import { WebWriteOp } from "@/lib/runtime/web-writes";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  await bootDb();
  const limits = await getEffectiveTradeLimits();
  const e = env();
  return NextResponse.json({
    ...limits,
    envFloors: {
      liveMaxPerTradeSol: e.LIVE_MAX_PER_TRADE_SOL,
      liveMaxDailySol: e.LIVE_MAX_DAILY_SOL,
    },
    liveExecution: e.LIVE_EXECUTION,
    liveDryRun: e.LIVE_DRY_RUN,
  });
}

type Body = {
  paperSizePerTradeSol?: number;
  liveMaxPerTradeSol?: number;
  liveMaxDailySol?: number;
  clearLiveMaxDaily?: boolean;
};

export async function PUT(req: Request) {
  await bootDb();
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const patch: Body = {};
  if (body.clearLiveMaxDaily === true) {
    patch.clearLiveMaxDaily = true;
  }
  for (const k of [
    "paperSizePerTradeSol",
    "liveMaxPerTradeSol",
    "liveMaxDailySol",
  ] as const) {
    const v = body[k];
    if (v === undefined) continue;
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
      return NextResponse.json({ error: `${k}_must_be_positive_number` }, { status: 400 });
    }
    patch[k] = v;
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "no_changes" }, { status: 400 });
  }
  const { correlationId } = await queueWebCommand(
    WebWriteOp.SETTINGS_LIMITS,
    "SETTINGS_LIMITS_REQUESTED",
    { limits: patch, strategy_id: "operator" },
    "settings-limits",
  );
  return NextResponse.json({ ok: true, queued: true, correlationId }, { status: 202 });
}
