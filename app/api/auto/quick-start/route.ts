import { NextResponse } from "next/server";
import { bootDb } from "@/lib/db/client";
import { DEFAULT_PARAMS, type AutoSessionParams, getActiveSession } from "@/lib/db/repos/auto-sessions";
import { queueWebCommand } from "@/lib/runtime/queue-command";
import { WebWriteOp } from "@/lib/runtime/web-writes";
import { validateAutoStart } from "@/lib/runtime/auto-session-queue";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PRESETS: Record<string, Partial<AutoSessionParams>> = {
  balanced: {
    sizeSol: 0.03,
    maxConcurrent: 5,
    signalStrictness: "strong_and_moderate",
    takeProfitPct: 0.28,
    // Tightened 0.15 → 0.12 (2026-06-15, 87-trade session 31 evidence: 24% of
    // trades hit SL on volatile sub-$60k mcap entries; SL bucket was −0.452 SOL
    // of the −0.470 total loss. −12% vSol = −22.6% value vs prior −27.75%).
    stopLossPct: 0.12,
    maxHoldMinutes: 45,
    tp1Pct: 0.15,
    tp1Fraction: 0.5,
    useLearnedAvoids: false,
  },
  conservative: {
    sizeSol: 0.02,
    maxConcurrent: 2,
    signalStrictness: "strong_and_moderate",
    stopLossPct: 0.12,
    takeProfitPct: 0.22,
    maxDailyLossSol: 0.18,
    maxHoldMinutes: 35,
    tp1Pct: 0.12,
    tp1Fraction: 0.5,
    useLearnedAvoids: false,
  },
  aggressive: {
    sizeSol: 0.04,
    maxConcurrent: 4,
    signalStrictness: "strong_and_moderate",
    stopLossPct: 0.15,
    takeProfitPct: 0.32,
    maxDailyLossSol: 0.45,
    maxHoldMinutes: 50,
    tp1Pct: 0.18,
    tp1Fraction: 0.5,
    useLearnedAvoids: false,
  },
};

export async function POST(req: Request) {
  await bootDb();

  const existing = await getActiveSession();
  if (existing) {
    return NextResponse.json({ ok: true, alreadyActive: true, session: existing });
  }

  const gate = await validateAutoStart();
  if ("error" in gate) {
    return NextResponse.json({ error: gate.error }, { status: gate.status });
  }

  let body: { preset?: string; sizeSol?: number; maxDailyLossSol?: number } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    /* empty */
  }

  const presetKey = body.preset && PRESETS[body.preset] ? body.preset : "balanced";
  const params: AutoSessionParams = {
    ...DEFAULT_PARAMS,
    ...PRESETS[presetKey],
    useLearnedAvoids: gate.mode === "live",
  };

  if (typeof body.sizeSol === "number" && Number.isFinite(body.sizeSol) && body.sizeSol > 0 && body.sizeSol <= 5) {
    params.sizeSol = Math.round(body.sizeSol * 10000) / 10000;
  }
  if (
    typeof body.maxDailyLossSol === "number" &&
    Number.isFinite(body.maxDailyLossSol) &&
    body.maxDailyLossSol > 0 &&
    body.maxDailyLossSol <= 1000
  ) {
    params.maxDailyLossSol = body.maxDailyLossSol;
  }

  const { correlationId } = await queueWebCommand(
    WebWriteOp.AUTO_SESSION_START,
    "AUTO_SESSION_START_REQUESTED",
    { mode: gate.mode, params, preset: presetKey, strategy_id: "auto_trader" },
    "auto-quick",
  );
  return NextResponse.json(
    {
      ok: true,
      queued: true,
      correlationId,
      statusUrl: `/api/trade/status/${correlationId}`,
      preset: presetKey,
      mode: gate.mode,
    },
    { status: 202 },
  );
}
