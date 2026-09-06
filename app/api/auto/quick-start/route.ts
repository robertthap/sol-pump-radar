import { NextResponse } from "next/server";
import { bootDb } from "@/lib/db/client";
import { DEFAULT_PARAMS, type AutoSessionParams, getActiveSession } from "@/lib/db/repos/auto-sessions";
import { queueWebCommand } from "@/lib/runtime/queue-command";
import { WebWriteOp } from "@/lib/runtime/web-writes";
import { validateAutoStart } from "@/lib/runtime/auto-session-queue";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PRESETS: Record<string, Partial<AutoSessionParams>> = {
  // Only enter coins whose trading is ACCELERATING with buyers on top.
  // Exits are identical to `balanced` on purpose: entry selectivity is the only
  // variable, so any difference in outcome is attributable to selection alone.
  //
  // Thresholds picked against the live ledger -- of 18 recent entries, 3 clear
  // these, including the ones with real flow, while the 0-buy/$0-volume and
  // 5-buy/17-sell entries are rejected. There is deliberately NO price threshold:
  // a 320-trade analysis found winners had NEGATIVE 5m price change at entry, so
  // requiring a rising price buys the local top. volAcceleration measures whether
  // the last 5 minutes are running hot versus the coin's own hourly pace.
  //
  // UNVALIDATED: in that same 18-trade sample every trade lost, including the
  // high-momentum ones. This cuts trade count; it is not yet shown to cut losses.
  momentum: {
    sizeSol: 0.03,
    maxConcurrent: 5,
    signalStrictness: "strong_and_moderate",
    takeProfitPct: 0.28,
    stopLossPct: 0.12,
    maxHoldMinutes: 45,
    tp1Pct: 0.15,
    tp1Fraction: 0.5,
    minDexBuysM5: 8,
    minDexBuySellRatio: 1.0,
    minDexVolAccel: 0.5,
    useLearnedAvoids: false,
  },
  // Fast turnover: take a small profit and free the slot in minutes rather than
  // holding for a big move. A HYPOTHESIS, not a validated setting -- every number
  // below is reasoned from the ledger (81% of trades never beat +3% and won 0 of
  // 61; the winners that exist mostly peak inside 15 min) and from the ~2%
  // round-trip friction, but it has not been replayed against recorded marks yet.
  // scripts/exit-policy-eval.ts is what will settle it.
  scalp: {
    sizeSol: 0.03,
    maxConcurrent: 5,
    signalStrictness: "strong_and_moderate",
    // Arm the trail early and keep it tight: exits land around +2-5% net of the
    // ~2% round trip instead of waiting for a move that usually never comes.
    trailingArmPct: 0.06,
    trailingStopPct: 0.04,
    // Bank half at +5% -- the 3-10% bucket is where the hit rate actually is (7 of 8).
    tp1Pct: 0.05,
    tp1Fraction: 0.5,
    // Unreachable while the trail arms first (documented); kept for live-path parity.
    takeProfitPct: 0.10,
    // Tighter than balanced: a scalp that is 8% down is not recovering in 12 min.
    stopLossPct: 0.08,
    maxHoldMinutes: 12,
    // The one cut the data supports without qualification: still under +3% at
    // 5 min means it is one of the 61 that never moved.
    stagnationMinutes: 5,
    stagnationMaxPeakPct: 0.03,
    useLearnedAvoids: false,
  },
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

  let body: { preset?: string; sizeSol?: number; maxDailyLossSol?: number; maxConcurrent?: number } = {};
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
  // Max open positions is a session-start parameter (the worker has no "edit a
  // running session"). Validated like the two fields above; the worker still
  // clamps to PAPER_MAX_OPEN_POSITIONS at runtime, so this is a request, not authority.
  if (
    typeof body.maxConcurrent === "number" &&
    Number.isInteger(body.maxConcurrent) &&
    body.maxConcurrent >= 1 &&
    body.maxConcurrent <= 50
  ) {
    params.maxConcurrent = body.maxConcurrent;
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
