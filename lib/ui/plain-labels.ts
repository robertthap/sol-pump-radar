/** Plain-language labels for beginner-facing UI. */

export function actionLabel(action: string): string {
  if (action === "BUY_STRONG") return "Strong buy";
  if (action === "BUY_MODERATE") return "Buy";
  if (action === "WATCH") return "Watch";
  if (action === "AVOID") return "Avoid";
  return action.replace(/_/g, " ").toLowerCase();
}

export function logKindLabel(kind: "open" | "close" | "skip" | "tp1"): string {
  if (kind === "open") return "Opened";
  if (kind === "close") return "Closed";
  if (kind === "skip") return "Skipped";
  return "Partial profit";
}

export function logSourceLabel(source: "paper" | "live" | "system"): string {
  if (source === "paper") return "demo";
  if (source === "live") return "live";
  return "system";
}

/** Plain label for auto-trader skip reasons stored in decision_log.executor_reason. */
export function autoSkipReasonLabel(reason: string): string {
  const map: Record<string, string> = {
    auto_session_active: "Handed off to auto-trader",
    "auto:already_open": "Already holding this coin",
    "auto:strictness": "Signal below strictness filter",
    "auto:no_v_sol": "No live price yet",
    "auto:bot_veto_or_low_edge": "Bot veto or low edge score",
    "auto:rug_label": "Rug or stall label",
    "auto:insufficient_demo_balance": "Demo balance too low",
  };
  return map[reason] ?? reason.replace(/^auto:/, "").replace(/_/g, " ");
}

export const HALT_LABEL = "Pause trading";
export const RESUME_LABEL = "Resume trading";

export function metricLabel(key: string): string {
  const map: Record<string, string> = {
    conf: "Strength",
    confluence: "Strength",
    v_sol: "Pool",
    M1: "Grad score",
    M3: "Rug score",
  };
  return map[key] ?? key;
}

/** Win rate needed to break even after fees at given TP/SL (fractions, e.g. 0.4 = 40%). */
export function breakevenWinRate(
  takeProfitPct: number,
  stopLossPct: number,
  roundTripFeesPct = 0.025,
): number {
  const tp = Math.max(0.01, takeProfitPct);
  const sl = Math.max(0.01, stopLossPct);
  const fees = Math.max(0, roundTripFeesPct);
  const num = sl + fees;
  const den = tp + sl;
  return Math.min(0.99, Math.max(0.01, num / den));
}

export function breakevenHintText(
  takeProfitPct: number,
  stopLossPct: number,
  roundTripFeesPct = 0.025,
): string {
  const pct = breakevenWinRate(takeProfitPct, stopLossPct, roundTripFeesPct) * 100;
  const tp = (takeProfitPct * 100).toFixed(0);
  const sl = (stopLossPct * 100).toFixed(0);
  return `You need about ${pct.toFixed(0)}% winning trades to break even at ${tp}% take-profit / ${sl}% stop-loss (after ~2.5% pump.fun fees).`;
}
