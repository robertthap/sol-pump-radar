export type SignalQualityInput = {
  action: string;
  confluenceScore: number;
  gradScore?: number | null;
  rugScore?: number | null;
  insiderScore?: number | null;
  washScore?: number | null;
  creatorScore?: number | null;
  smartMoneyCount?: number;
  rugLabel?: string | null;
  vetoes?: string[];
  executed?: string;
};

export type SignalQuality = {
  score: number;
  tier: "hot" | "good" | "fair" | "weak" | "avoid";
  tradable: boolean;
  tags: string[];
};

const CONFLUENCE_MIN: Record<string, number> = {
  BUY_STRONG: 0.56,
  BUY_MODERATE: 0.48,
};

/** Client + server safe; defaults to profit when SIGNAL_MODE unset. */
function profitModeActive(): boolean {
  const mode =
    typeof process !== "undefined"
      ? process.env.SIGNAL_MODE ?? process.env.NEXT_PUBLIC_SIGNAL_MODE
      : undefined;
  return mode !== "launch";
}

export function scoreSignal(input: SignalQualityInput): SignalQuality {
  const tags: string[] = [];
  const vetoes = input.vetoes ?? [];
  const rugLabel = input.rugLabel ?? "active";
  const sm = input.smartMoneyCount ?? 0;
  const grad = input.gradScore ?? 0.5;
  const rug = input.rugScore ?? 0;
  const insider = input.insiderScore ?? 0;
  const wash = input.washScore ?? 0;
  const creator = input.creatorScore ?? 0;

  if (input.action === "AVOID") {
    return { score: 0, tier: "avoid", tradable: false, tags: ["avoid"] };
  }

  if (rugLabel === "rugged") {
    return { score: 5, tier: "avoid", tradable: false, tags: [rugLabel] };
  }
  const profit = profitModeActive();
  if (rugLabel === "stalled" && !profit) {
    return { score: 5, tier: "avoid", tradable: false, tags: [rugLabel] };
  }
  if (rugLabel === "stalled" && profit) {
    tags.push("stalled-caution");
  }

  let score = 0;

  // Confluence (0–38)
  score += Math.min(38, Math.max(0, input.confluenceScore * 55));

  // Action tier (0–22)
  if (input.action === "BUY_STRONG") score += 22;
  else if (input.action === "BUY_MODERATE") score += 12;
  else if (input.action === "WATCH") score += 6;

  // Module strength (0–20)
  score += Math.min(12, Math.max(0, (grad - rug) * 18));
  if (sm >= 2) {
    score += 8;
    tags.push("smart-money");
  } else if (sm >= 1) {
    score += 4;
    tags.push("insider");
  }

  // Penalties
  if (rug >= 0.38) {
    score -= 18;
    tags.push("rug-risk");
  }
  if (insider >= 0.58) {
    score -= 25;
    tags.push("insider-heavy");
  }
  if (wash >= 0.65) {
    score -= 20;
    tags.push("wash");
  }
  if (creator >= 0.65) {
    score -= 12;
    tags.push("creator-risk");
  }
  for (const v of vetoes) {
    const lower = v.toLowerCase();
    if (lower.includes("bundle") || lower.includes("mechanical")) {
      score -= 30;
      tags.push("veto");
      break;
    }
  }

  if (input.executed === "executed_paper" || input.executed?.startsWith("executed")) {
    score += 3;
    tags.push("traded");
  }

  score = Math.round(Math.max(0, Math.min(100, score)));

  let tier: SignalQuality["tier"] = "weak";
  if (score >= 82) tier = "hot";
  else if (score >= 68) tier = "good";
  else if (score >= 52) tier = "fair";
  else if (input.action === "AVOID") tier = "avoid";

  const minConf = CONFLUENCE_MIN[input.action];
  const confOk = minConf == null || input.confluenceScore >= (profit ? minConf - 0.04 : minConf);
  const moderateMinScore = profit ? 62 : 72;
  const tradable =
    (input.action === "BUY_STRONG" || (input.action === "BUY_MODERATE" && score >= moderateMinScore)) &&
    confOk &&
    rug < (profit ? 0.42 : 0.38) &&
    insider < 0.58 &&
    wash < 0.65 &&
    creator < 0.65 &&
    rugLabel !== "rugged" &&
    (profit || rugLabel !== "stalled") &&
    score >= (profit ? 60 : 65) &&
    !tags.includes("veto");

  if (tradable) tags.push("tradable");
  if (
    tradable &&
    input.executed === "pending" &&
    (input.action === "BUY_STRONG" || input.action === "BUY_MODERATE")
  ) {
    tags.push("auto-ready");
  }

  return { score, tier, tradable, tags };
}

export function tierClass(tier: SignalQuality["tier"]): string {
  switch (tier) {
    case "hot":
      return "border-ok/70 bg-ok/20 text-ok";
    case "good":
      return "border-ok/40 bg-ok/10 text-ok";
    case "fair":
      return "border-accent/40 bg-accent/10 text-accent";
    case "avoid":
      return "border-bad/50 bg-bad/15 text-bad";
    default:
      return "border-border text-muted";
  }
}
