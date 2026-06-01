/** Lifecycle states as primary UI language (not price). */

export type MomentumStateKey =
  | "cold"
  | "launching"
  | "early_breakout"
  | "acceleration"
  | "trend"
  | "parabolic"
  | "exhaustion"
  | "collapse"
  | string;

export type StateVisual = {
  label: string;
  short: string;
  text: string;
  bg: string;
  border: string;
  bar: string;
};

const STATE_MAP: Record<string, StateVisual> = {
  cold: {
    label: "COLD",
    short: "COLD",
    text: "text-zinc-400",
    bg: "bg-zinc-500/15",
    border: "border-zinc-500/40",
    bar: "bg-zinc-500",
  },
  launching: {
    label: "LAUNCH",
    short: "LNCH",
    text: "text-sky-400",
    bg: "bg-sky-500/15",
    border: "border-sky-500/40",
    bar: "bg-sky-500",
  },
  early_breakout: {
    label: "BREAK",
    short: "BRK",
    text: "text-cyan-400",
    bg: "bg-cyan-500/15",
    border: "border-cyan-500/40",
    bar: "bg-cyan-400",
  },
  acceleration: {
    label: "ACCEL",
    short: "ACC",
    text: "text-emerald-400",
    bg: "bg-emerald-500/15",
    border: "border-emerald-500/40",
    bar: "bg-emerald-500",
  },
  trend: {
    label: "TREND",
    short: "TRD",
    text: "text-lime-400",
    bg: "bg-lime-500/15",
    border: "border-lime-500/40",
    bar: "bg-lime-500",
  },
  parabolic: {
    label: "PARA",
    short: "PAR",
    text: "text-orange-400",
    bg: "bg-orange-500/15",
    border: "border-orange-500/40",
    bar: "bg-orange-500",
  },
  exhaustion: {
    label: "EXHST",
    short: "EXH",
    text: "text-red-400",
    bg: "bg-red-500/15",
    border: "border-red-500/40",
    bar: "bg-red-500",
  },
  collapse: {
    label: "COLLAPSE",
    short: "COL",
    text: "text-red-900",
    bg: "bg-red-950/40",
    border: "border-red-900/50",
    bar: "bg-red-900",
  },
};

const FALLBACK: StateVisual = STATE_MAP.cold;

export function stateVisual(state: string): StateVisual {
  const key = state?.toLowerCase().replace(/\s+/g, "_") ?? "cold";
  return STATE_MAP[key] ?? FALLBACK;
}

/** Momentum bars from rank percentile + velocity (not price). */
export function momentumBars(rankPct: number, rankVelocity: number, _state: string): string {
  const energy = Math.min(5, Math.max(0, Math.round(rankPct * 3 + Math.max(0, rankVelocity) * 8)));
  if (energy <= 0) return "·";
  return "▲".repeat(energy);
}

export function lifecycleOrder(state: string): number {
  const order: Record<string, number> = {
    cold: 0,
    launching: 1,
    early_breakout: 2,
    acceleration: 3,
    trend: 4,
    parabolic: 5,
    exhaustion: 6,
    collapse: 7,
  };
  return order[state] ?? 0;
}

export function isEarlyLifecycle(state: string): boolean {
  return ["launching", "early_breakout", "acceleration"].includes(state);
}
