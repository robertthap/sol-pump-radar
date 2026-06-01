export type TradeableStatus = "yes" | "no" | "caution" | "wait";

export type TradeableInput = {
  rugLabel: string | null;
  ageSeconds: number;
  action: string | null;
  hasBundle: boolean;
  mechanicalUptrend: boolean;
  hasSniper: boolean;
  tradeCount: number;
  confluence: number | null;
  inactivitySeconds: number | null;
  pumpMultiple?: number | null;
  insiderSignal?: boolean;
};

export type TradeableResult = {
  status: TradeableStatus;
  reason: string;
};

/** Client-safe mirror of server classifyTradeable. */
export function classifyTradeable(row: TradeableInput): TradeableResult {
  const lateChaseCap =
    typeof process !== "undefined" && process.env.SIGNAL_MODE === "launch" ? 2.5 : 3.5;
  if (row.ageSeconds < 90) {
    return { status: "wait", reason: "Brand new — waiting for trades" };
  }
  if (row.rugLabel === "rugged") {
    return { status: "no", reason: "Rug-labelled (no swaps 10m+)" };
  }
  if (row.pumpMultiple != null && row.pumpMultiple >= lateChaseCap) {
    return { status: "no", reason: `Late chase (${row.pumpMultiple.toFixed(1)}× pump) — trap risk` };
  }
  if (row.hasBundle || row.mechanicalUptrend) {
    return { status: "no", reason: "Manipulation flags (bundle / mechanical curve)" };
  }
  if (row.hasSniper && (row.confluence ?? 0) < 0.55) {
    return { status: "no", reason: "Sniper ring exposure" };
  }
  if (row.tradeCount === 0) {
    return { status: "wait", reason: "No buys/sells yet" };
  }
  if (row.rugLabel === "stalled" || (row.inactivitySeconds != null && row.inactivitySeconds >= 180)) {
    return { status: "caution", reason: "Stalled — no recent swaps" };
  }
  if (row.action === "AVOID") {
    return { status: "no", reason: "Model: avoid" };
  }
  if (row.action === "BUY_STRONG") {
    return {
      status: "yes",
      reason: row.insiderSignal ? "Strong buy + smart wallets in flow" : "Strong buy signal",
    };
  }
  if (row.action === "BUY_MODERATE") {
    return { status: "yes", reason: "Buy signal" };
  }
  if (row.action === "WATCH" && (row.confluence ?? 0) >= 0.45) {
    return { status: "caution", reason: "Watch — not a full buy yet" };
  }
  if (row.confluence != null && row.confluence >= 0.55) {
    return { status: "caution", reason: "Scores OK — no buy action yet" };
  }
  return { status: "wait", reason: "Not scored / below threshold" };
}

export function rugDisplayLabel(
  rugLabel: string | null,
  ageSeconds: number,
  inactivitySeconds: number | null,
): { label: string; tone: "ok" | "warn" | "bad" | "muted" } {
  if (rugLabel === "rugged") return { label: "Rug", tone: "bad" };
  if (rugLabel === "stalled") return { label: "Stalled", tone: "warn" };
  if (rugLabel === "active") return { label: "Active", tone: "ok" };
  if (ageSeconds < 600) return { label: "New", tone: "muted" };
  if (inactivitySeconds != null && inactivitySeconds >= 600) {
    return { label: "Likely rug", tone: "bad" };
  }
  if (inactivitySeconds != null && inactivitySeconds >= 180) {
    return { label: "Slowing", tone: "warn" };
  }
  return { label: "Active", tone: "ok" };
}
