import { NextResponse } from "next/server";
import { bootDb } from "@/lib/db/client";
import { DEFAULT_PARAMS, type AutoSessionParams } from "@/lib/db/repos/auto-sessions";
import { getActiveSession } from "@/lib/db/repos/auto-sessions";
import { queueWebCommand } from "@/lib/runtime/queue-command";
import { WebWriteOp } from "@/lib/runtime/web-writes";
import { validateAutoStart } from "@/lib/runtime/auto-session-queue";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Body = { mode?: "paper" | "live"; params?: Partial<AutoSessionParams> };

export async function POST(req: Request) {
  await bootDb();
  const existing = await getActiveSession();
  if (existing) {
    return NextResponse.json({ ok: true, alreadyActive: true, session: existing });
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    body = {};
  }

  const gate = await validateAutoStart(body.mode);
  if ("error" in gate) {
    return NextResponse.json({ error: gate.error }, { status: gate.status });
  }

  const merged: AutoSessionParams = {
    ...DEFAULT_PARAMS,
    ...(body.params ?? {}),
    useLearnedAvoids: gate.mode === "live" ? (body.params?.useLearnedAvoids ?? true) : false,
  };

  if (merged.sizeSol <= 0 || merged.sizeSol > 100) {
    return NextResponse.json({ error: "sizeSol out of range" }, { status: 400 });
  }
  if (merged.takeProfitPct <= 0 || merged.takeProfitPct > 10) {
    return NextResponse.json({ error: "takeProfitPct out of range" }, { status: 400 });
  }
  if (merged.stopLossPct <= 0 || merged.stopLossPct >= 1) {
    return NextResponse.json({ error: "stopLossPct out of range" }, { status: 400 });
  }
  if (merged.maxConcurrent < 1 || merged.maxConcurrent > 50) {
    return NextResponse.json({ error: "maxConcurrent out of range" }, { status: 400 });
  }
  if (merged.maxDailyLossSol <= 0 || merged.maxDailyLossSol > 1000) {
    return NextResponse.json({ error: "maxDailyLossSol out of range" }, { status: 400 });
  }
  if (
    merged.stagnationMinutes != null &&
    (merged.stagnationMinutes < 1 || merged.stagnationMinutes > 240)
  ) {
    return NextResponse.json({ error: "stagnationMinutes out of range" }, { status: 400 });
  }
  if (
    merged.stagnationMaxPeakPct != null &&
    (merged.stagnationMaxPeakPct < 0 || merged.stagnationMaxPeakPct > 1)
  ) {
    return NextResponse.json({ error: "stagnationMaxPeakPct out of range" }, { status: 400 });
  }
  if (merged.minDexBuysM5 != null && (merged.minDexBuysM5 < 0 || merged.minDexBuysM5 > 1000)) {
    return NextResponse.json({ error: "minDexBuysM5 out of range" }, { status: 400 });
  }
  if (merged.minDexBuySellRatio != null && (merged.minDexBuySellRatio < 0 || merged.minDexBuySellRatio > 100)) {
    return NextResponse.json({ error: "minDexBuySellRatio out of range" }, { status: 400 });
  }
  if (merged.minDexVolAccel != null && (merged.minDexVolAccel < 0 || merged.minDexVolAccel > 100)) {
    return NextResponse.json({ error: "minDexVolAccel out of range" }, { status: 400 });
  }

  const { correlationId } = await queueWebCommand(
    WebWriteOp.AUTO_SESSION_START,
    "AUTO_SESSION_START_REQUESTED",
    { mode: gate.mode, params: merged, strategy_id: "auto_trader" },
    "auto-start",
  );
  return NextResponse.json(
    {
      ok: true,
      queued: true,
      correlationId,
      statusUrl: `/api/trade/status/${correlationId}`,
    },
    { status: 202 },
  );
}
