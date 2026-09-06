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
    // Take the momentum bar at half height when quality wallets are buying.
    // The baseline dead/dumping veto still applies at full strength.
    smartMoneyBoost: true,
    useLearnedAvoids: false,
  },
  // Only enter when a wallet worth following is buying. Exits are identical to
  // `balanced` on purpose, exactly as `momentum` is: entry selection stays the
  // only variable, so a difference in outcome is attributable to selection.
  //
  // UNVALIDATED, and with a known blind spot worth stating plainly: `events`
  // holds bonding-curve trades only (PUMPSWAP_INGEST off), so a watched wallet
  // buying a graduated coin is invisible to us. This preset will therefore skip
  // trades it should have taken. It fails in the safe direction, but expect a
  // LOW trade count -- across a 40-mint live sample, exactly one mint had any
  // qualifying buyer at all, and that one was a bundle ring the safety check
  // rejected. Turning on PumpSwap ingestion is what would make this preset
  // measurable.
  smartMoney: {
    sizeSol: 0.03,
    maxConcurrent: 5,
    signalStrictness: "strong_and_moderate",
    requireSmartMoney: "strong",
    takeProfitPct: 0.28,
    stopLossPct: 0.12,
    maxHoldMinutes: 45,
    tp1Pct: 0.15,
    tp1Fraction: 0.5,
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
    // Scalp has no momentum thresholds of its own, so this does not currently
    // change which coins it buys -- it makes the worker RECORD whether smart
    // money was present at each entry ("smart money present" in the log). That
    // record is what will answer whether the signal correlates with scalp
    // winners at all, which nothing in our data can answer today. Costs one
    // indexed query per candidate; becomes load-bearing if scalp ever gains
    // minDex* thresholds.
    smartMoneyBoost: true,
    useLearnedAvoids: false,
  },
  // "Put in 0.1 SOL, take $2 out, do it often." Three changes from balanced,
  // each traceable to a measurement rather than a preference:
  //
  // 1. CURVE BAND (the entry change, and the only one with an edge argument).
  //    The operator's watchlist buys in a tight vSol 46-69 window, median 54.5
  //    over 243 buys. This bot enters at a median of 150, with 86% of its 1,082
  //    trades above vSol 70 -- at or past graduation. Sorting our own closed
  //    trades by entry band, +13.3% is reached 15.8% of the time below vSol 45
  //    and 12.5% between 45 and 70, against 7.7% above 70. Widened to 20-70 to
  //    cover both good buckets. SMALL SAMPLES below 70 (19 and 48 trades): this
  //    is a hypothesis about where to fish, not a proven edge.
  //
  // 2. CASH TARGET. profitTargetUsd replaces takeProfitPct, converted per exit
  //    pass against real friction: $2 on 0.1 SOL at SOL=$150 is +13.3% net,
  //    which is a +7.5% move in vSol. Break-even alone is +2.02%.
  //
  // 3. NO TRAILING STOP, deliberately. A trail arms below the target and would
  //    exit at +6-8%, which is not the "$2, no more no less" that was asked for.
  //    Exits are TP, SL, the 3-minute flat cut, or the 10-minute timeout.
  //
  // THE ARITHMETIC TO WATCH, stated plainly because it decides whether this
  // works: with TP +13.3% and SL -6%, break-even needs a 31% win rate. Our
  // measured rate in this band is 12.5-15.8% -- though that is EXIT-based, and
  // a target this tight banks moves the current policy rides back down, so the
  // real rate should be higher. How much higher is exactly what position_marks
  // is now recording. Until that says otherwise this preset is UNPROVEN, and
  // "more trades per minute" multiplies whatever the expectancy turns out to
  // be -- including a negative one.
  compounder: {
    sizeSol: 0.1,
    maxConcurrent: 10,
    signalStrictness: "strong_and_moderate",
    minEntryVSol: 20,
    maxEntryVSol: 70,
    profitTargetUsd: 2,
    // Fallback only, used if the cash target is ever refused as implausible.
    takeProfitPct: 0.133,
    stopLossPct: 0.06,
    maxHoldMinutes: 10,
    stagnationMinutes: 3,
    stagnationMaxPeakPct: 0.02,
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
