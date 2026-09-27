export const STRATEGIES = {
  graduation: {
    name: "Graduation Scout (V1)", phase: "After graduation", size: 0.552, hold: 600,
    description: "At pool open +5s, buy when log(start price / standard graduation price) ≤ 0.6931. Score the frozen exit tree every second; exit at its threshold or 600s.",
    caveat: "Requires a recorded graduation and enough trades from one AMM pool to reconstruct reserves. Pool class is not an entry filter.",
    reported: "−0.38% / −0.27% / −0.55% excess; indistinguishable from random.",
  },
  curveLadder: {
    name: "Curve Ladder", phase: "Before graduation", size: 0.349, hold: 31,
    description: "At the first crossing of 5, 10, 15, 20, 25, 30, 40, 50 or 65 SOL: crossing size ≤ 2.93369 SOL, largest buyer share ≤ 32.04%, and progress rate > 0.00256623/s. Exit after 31s or at graduation.",
    caveat: "The rate needs about 26.18 SOL of growth in 120s. Low rungs usually cannot qualify. Compare within each crossing level.",
    reported: "−0.09% / −0.44% / −0.37% excess; indistinguishable from random.",
  },
  scaleIn: {
    name: "Winner Scale-In", phase: "During an open position", size: 0.349, hold: 31,
    description: "From hold second 1, add one 0.349 SOL tranche at the first second with log(spot / entry spot) > 0 and a non-target trade less than 3s ago. Close both tranches on the original 31s timer or graduation.",
    caveat: "This is an add rule, not an entry rule. This lab opens a baseline position at every valid first curve crossing, then isolates the add's incremental P&L. Controls add at the same hold second and crossing level.",
    reported: "−0.199% / −0.146% / −0.117% excess; worse than matched random adds.",
  },
} as const;

export type StrategyId = keyof typeof STRATEGIES;
export const EXECUTION = {
  OPTIMISTIC: { delay: 1, slippageBps: 0, failure: 0.005, priority: 0.00002, mevBps: 0 },
  BASE: { delay: 3, slippageBps: 25, failure: 0.02, priority: 0.00005, mevBps: 30 },
  CONSERVATIVE: { delay: 8, slippageBps: 75, failure: 0.05, priority: 0.0002, mevBps: 100 },
} as const;
export type ExecutionSetting = keyof typeof EXECUTION;
export const CURVE_K = 3.219e10;
export const PROGRESS_SOL = 85;
export const GRADUATION_PRICE = 84.99 / 206.9e6;
export const DEX_FEE = 0.0125;
export const BASE_TX_FEE = 0.000005;

export type TapeEvent = {
  id: number; mint: string; ts: number; slot: number;
  kind: string; venue: string; pool: string | null; wallet: string | null;
  side: string | null; sol: number | null; tokens: number | null; vSol: number | null;
  /** Explicit provenance where supplied; the DB currently has no pool-class field. */
  poolClass?: string;
};
export type ReplayOptions = { strategy: StrategyId; setting: ExecutionSetting; targetWallet?: string; seed?: number; fromTs?: number };
export type Outcome = "CLOSED" | "NO_FILL" | "DATA_UNAVAILABLE" | "CENSORED" | "SKIPPED";
export type Point = { second: number; price: number; hazard: number | null };
export type Episode = {
  id: string; mint: string; poolClass: string; level: number | null; decisionTs: number;
  fired: boolean; status: Outcome; reason: string;
  features: Record<string, number | null>; checks: Record<string, boolean | null>;
  entryTs: number | null; exitTs: number | null; addSecond: number | null;
  stakeSol: number; pnlSol: number | null; netReturn: number | null;
  /** Return on the added tranche, relative to the identical no-add position. */
  incrementalReturn: number | null;
  points: Point[];
};
