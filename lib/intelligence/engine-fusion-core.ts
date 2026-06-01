/** Pure fusion logic (testable, no server-only). */

export type FusionSignal =
  | "BUY_STRONG"
  | "BUY_MODERATE"
  | "CONTINUATION_BUY"
  | "DEX_TREND_ALERT"
  | "EXHAUSTION_WARNING"
  | "WATCH"
  | "AVOID"
  | "NONE";

export type FusionCandidate = {
  mint: string;
  engine: "A" | "B";
  state: string;
  signal: FusionSignal;
  confidence: number;
  rank_percentile: number;
  miss_type?: string | null;
};

const SIGNAL_PRIORITY: Record<FusionSignal, number> = {
  BUY_STRONG: 100,
  CONTINUATION_BUY: 95,
  DEX_TREND_ALERT: 85,
  BUY_MODERATE: 80,
  EXHAUSTION_WARNING: 40,
  WATCH: 30,
  AVOID: 20,
  NONE: 0,
};

const EARLY_STATES = new Set(["launching", "early_breakout", "acceleration", "trend"]);

function stateEarlyBonus(state: string): number {
  return EARLY_STATES.has(state) ? 15 : 0;
}

export function pickFusionWinner(
  a: FusionCandidate | null,
  b: FusionCandidate | null,
): { winner: FusionCandidate; engine: "A" | "B"; reason: string } {
  const candidates: Array<{ out: FusionCandidate; engine: "A" | "B" }> = [];
  if (a) candidates.push({ out: a, engine: "A" });
  if (b) candidates.push({ out: b, engine: "B" });

  if (candidates.length === 0) {
    return {
      winner: {
        mint: "",
        engine: "B",
        state: "cold",
        signal: "NONE",
        confidence: 0,
        rank_percentile: 0,
        miss_type: "NOT_IN_UNIVERSE",
      },
      engine: "B",
      reason: "no_candidates",
    };
  }

  candidates.sort((x, y) => {
    const px = SIGNAL_PRIORITY[x.out.signal] + stateEarlyBonus(x.out.state);
    const py = SIGNAL_PRIORITY[y.out.signal] + stateEarlyBonus(y.out.state);
    if (py !== px) return py - px;
    if (y.out.confidence !== x.out.confidence) return y.out.confidence - x.out.confidence;
    return y.out.rank_percentile - x.out.rank_percentile;
  });

  const top = candidates[0]!;
  return {
    winner: top.out,
    engine: top.engine,
    reason: `priority=${top.out.signal}|state=${top.out.state}|engine=${top.engine}`,
  };
}

export function fuseMissTypeCore(
  winner: FusionCandidate,
  a: FusionCandidate | null,
  b: FusionCandidate | null,
): string | null {
  if (winner.signal !== "NONE" && winner.signal !== "WATCH") return null;
  return a?.miss_type ?? b?.miss_type ?? winner.miss_type ?? "NO_STATE_TRANSITION";
}
