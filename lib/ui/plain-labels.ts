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

/**
 * Plain-language label + "what this means" hint for ANY auto-trader skip reason —
 * both the `auto:*` executor codes and the freeform filter messages that show in
 * the live log (e.g. "confluence 0.21 < 0.32", "coin gate failed: grad=0.06").
 */
export function formatAutoSkip(reason: string): { label: string; hint: string } {
  const r = (reason ?? "").toLowerCase();
  const match = (re: RegExp) => re.test(r);

  if (match(/confluence/)) {
    return { label: "Signal too weak", hint: "Conviction score was below the entry threshold — the setup wasn't strong enough." };
  }
  if (match(/no (live )?price|no v_?sol|no vsol/)) {
    return { label: "No live price yet", hint: "Couldn't fetch a fresh pool price for this brand-new mint. It retries automatically." };
  }
  if (match(/insider/)) {
    return { label: "Insider-concentrated", hint: "Too much supply sits with insider/connected wallets — high dump risk." };
  }
  if (match(/rug/)) {
    return { label: "Rug risk too high", hint: "Rug-pattern score crossed the safety cap for entries." };
  }
  if (match(/wash/)) {
    return { label: "Wash-trading risk", hint: "Volume looks self-traded rather than organic." };
  }
  if (match(/creator/)) {
    return { label: "Risky creator", hint: "The deployer wallet has a poor launch/rug history." };
  }
  if (match(/bundle|mechanical/)) {
    return { label: "Bundled launch", hint: "Coordinated bot/bundle buying at launch — not organic demand." };
  }
  if (match(/too early|sniper window/)) {
    return { label: "Too new — waiting", hint: "Inside the early sniper window; the system waits for real confirmation." };
  }
  if (match(/too late|extended|parabolic/)) {
    return { label: "Too late / extended", hint: "Already ran too far; entering now is poor risk/reward." };
  }
  if (match(/thin liquidity|vsol=|size .* too large/)) {
    return { label: "Liquidity too thin", hint: "Pool too shallow for the trade size without heavy slippage." };
  }
  if (match(/edge/)) {
    return { label: "Edge too low", hint: "Expected profit after fees didn't clear the minimum edge." };
  }
  if (match(/already_open|already holding/)) {
    return { label: "Already holding", hint: "You already have an open position in this coin." };
  }
  if (match(/max_concurrent|positions open/)) {
    return { label: "At position limit", hint: "Max concurrent positions reached — frees up as trades close." };
  }
  if (match(/micro-sim/)) {
    return { label: "Execution risk (sim)", hint: "Pre-trade simulation flagged slippage/thin depth/gas spike." };
  }
  if (match(/kill-switch|cooldown/)) {
    return { label: "Paused (risk guard)", hint: "Kill-switch paused entries after a loss streak; auto-resumes after cooldown." };
  }
  // Fall back to the executor-code map, then a generic cleanup.
  const code = autoSkipReasonLabel(reason);
  return { label: code, hint: "Filtered by the entry gate." };
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
