import type { MarketCoinAnalysis, MarketPrimaryFlag } from "@/lib/market/types";

export function actionLabel(action: string | null): string {
  if (!action) return "Scanning";
  if (action === "BUY_STRONG") return "Strong buy";
  if (action === "BUY_MODERATE") return "Buy";
  if (action === "WATCH") return "Watch";
  if (action === "AVOID") return "Avoid";
  return action.replace(/_/g, " ");
}

export function derivePrimaryFlag(input: {
  action: string | null;
  tradable: boolean;
  tradeableStatus: "yes" | "no" | "caution" | "wait";
  rugLabel: string | null;
  qualityTier: MarketCoinAnalysis["qualityTier"];
  hasScores: boolean;
  hasLocalEvents?: boolean;
}): { primaryFlag: MarketPrimaryFlag; flagLabel: string } {
  if (input.rugLabel === "rugged") {
    return { primaryFlag: "rug", flagLabel: "Rug" };
  }
  if (input.rugLabel === "stalled") {
    return { primaryFlag: "caution", flagLabel: "Stalled" };
  }
  if (input.action === "AVOID" || input.qualityTier === "avoid") {
    return { primaryFlag: "avoid", flagLabel: "Avoid" };
  }
  if (!input.hasScores) {
    if (input.hasLocalEvents === false) {
      return { primaryFlag: "scanning", flagLabel: "Scanning…" };
    }
    if (input.hasLocalEvents) {
      return { primaryFlag: "warming_up", flagLabel: "Warming up" };
    }
    return { primaryFlag: "scanning", flagLabel: "Scanning…" };
  }
  if (input.tradable && input.action === "BUY_STRONG") {
    return { primaryFlag: "strong_buy", flagLabel: "Strong buy" };
  }
  if (input.tradable && input.action === "BUY_MODERATE") {
    return { primaryFlag: "buy", flagLabel: "Tradable buy" };
  }
  if (input.tradable) {
    return { primaryFlag: "tradable", flagLabel: "Tradable" };
  }
  if (input.tradeableStatus === "wait") {
    return { primaryFlag: "wait", flagLabel: "Wait" };
  }
  if (input.tradeableStatus === "caution" || input.action === "WATCH") {
    return { primaryFlag: "caution", flagLabel: "Caution" };
  }
  if (input.action === "BUY_STRONG") {
    return { primaryFlag: "strong_buy", flagLabel: "Strong buy" };
  }
  if (input.action === "BUY_MODERATE") {
    return { primaryFlag: "buy", flagLabel: "Buy signal" };
  }
  if (input.action === "WATCH") {
    return { primaryFlag: "watch", flagLabel: "Watch" };
  }
  return { primaryFlag: "caution", flagLabel: "Not tradable" };
}

export function flagClass(flag: MarketPrimaryFlag): string {
  switch (flag) {
    case "strong_buy":
      return "market-flag-strong";
    case "buy":
    case "tradable":
      return "market-flag-buy";
    case "watch":
      return "market-flag-watch";
    case "caution":
    case "wait":
      return "market-flag-caution";
    case "avoid":
    case "rug":
      return "market-flag-avoid";
    case "warming_up":
    default:
      return "market-flag-scan";
  }
}
