/**
 * Execution Normalizer contract (PURE — no server-only, testable). L3.5.
 *
 * Every trade flows through one seam: TradeIntent → ExecutionPlan →
 * ExecutionOutcome. Paper and live are logically identical but temporally
 * different (live has RPC delay, slippage, partial fills, retries; paper fills
 * instantly with simulated friction). Normalizing both into a comparable
 * `ExecutionOutcome` lets the learner attribute *execution* cost separately from
 * *strategy* edge (the L5 3-layer memory) and never mis-blame one for the other.
 *
 * Named `ExecutionOutcome` (not `ExecutionResult`) to avoid colliding with the
 * `ExecutionResult<T>` Result-wrapper already exported by `@spr/trading`.
 */

export type TradeMode = "paper" | "live";
export type TradeSide = "buy" | "sell";
export type TradeRoute = "pumpportal" | "jupiter" | "paper";
export type ExecutionStatus = "filled" | "partial" | "rejected" | "failed" | "dry_run";

/** What the strategy/risk engine decided (pre-execution, no venue detail). */
export type TradeIntent = {
  intentId: string;
  mint: string;
  side: TradeSide;
  mode: TradeMode;
  sizeSol: number;
  reason: string;
  tier: "strict" | "relaxed" | "launch_snipe" | "continuation";
  regime: string;
  createdAtMs: number;
};

/** Resolved venue + expectations, built by the Execution Plan Builder. */
export type ExecutionPlan = {
  intent: TradeIntent;
  route: TradeRoute;
  expectedPriceSol: number;
  maxSlippageBps: number;
  priorityFeeSol: number;
  poolLiquiditySol: number;
  plannedAtMs: number;
};

/** Normalized post-execution truth — the only thing the learner trains on. */
export type ExecutionOutcome = {
  plan: ExecutionPlan;
  status: ExecutionStatus;
  fillPriceSol: number | null;
  filledSol: number;
  slippageBpsRealized: number;
  latencyMs: number;
  retries: number;
  txSig: string | null;
  rejectReason: string | null;
  filledAtMs: number;
};

export function computeSlippageBps(expectedPriceSol: number, fillPriceSol: number): number {
  if (!(expectedPriceSol > 0) || !(fillPriceSol > 0)) return 0;
  return Math.round(((fillPriceSol - expectedPriceSol) / expectedPriceSol) * 10_000);
}

export type PlanInputs = {
  route: TradeRoute;
  expectedPriceSol: number;
  maxSlippageBps: number;
  priorityFeeSol: number;
  poolLiquiditySol: number;
  /** Defaults to Date.now(); injectable for tests. */
  plannedAtMs?: number;
};

export function buildExecutionPlan(intent: TradeIntent, p: PlanInputs): ExecutionPlan {
  return {
    intent,
    route: p.route,
    expectedPriceSol: p.expectedPriceSol,
    maxSlippageBps: p.maxSlippageBps,
    priorityFeeSol: p.priorityFeeSol,
    poolLiquiditySol: p.poolLiquiditySol,
    plannedAtMs: p.plannedAtMs ?? Date.now(),
  };
}

export type RawFill = {
  status: ExecutionStatus;
  fillPriceSol: number | null;
  filledSol: number;
  /** Realized slippage if the executor already computed it; else derived. */
  slippageBpsRealized?: number;
  retries?: number;
  txSig?: string | null;
  rejectReason?: string | null;
  filledAtMs?: number;
};

/** Fold an executor's raw result + the plan into a normalized outcome. */
export function toExecutionOutcome(plan: ExecutionPlan, raw: RawFill): ExecutionOutcome {
  const filledAtMs = raw.filledAtMs ?? Date.now();
  return {
    plan,
    status: raw.status,
    fillPriceSol: raw.fillPriceSol,
    filledSol: raw.filledSol,
    slippageBpsRealized:
      raw.slippageBpsRealized ?? computeSlippageBps(plan.expectedPriceSol, raw.fillPriceSol ?? 0),
    latencyMs: Math.max(0, filledAtMs - plan.intent.createdAtMs),
    retries: raw.retries ?? 0,
    txSig: raw.txSig ?? null,
    rejectReason: raw.rejectReason ?? null,
    filledAtMs,
  };
}

/** Compact execution-memory record stamped onto entry_features (L5 L2 layer). */
export function execMemoryFields(o: ExecutionOutcome): Record<string, number | string | null> {
  return {
    exec_status: o.status,
    exec_route: o.plan.route,
    exec_fill_price: o.fillPriceSol,
    exec_slippage_bps: o.slippageBpsRealized,
    exec_latency_ms: o.latencyMs,
    exec_retries: o.retries,
    exec_expected_price: o.plan.expectedPriceSol,
  };
}
