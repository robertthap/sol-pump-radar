import "server-only";
import type { OpenIntent } from "@spr/trading";
import { paperOpen } from "@/lib/paper/engine";
import {
  toExecutionOutcome,
  type ExecutionPlan,
  type ExecutionOutcome,
} from "@/lib/executor/exec-normalize";

export type TradeExecution = {
  outcome: ExecutionOutcome;
  positionId: bigint | null;
};

/**
 * Single paper execution seam: runs the open and folds the engine's result into
 * a normalized {@link ExecutionOutcome}. The paper engine already returns
 * fill/slippage/latency, so this is a thin, faithful normalization. (Live opens
 * still flow through `executeLiveBuy`; migrating them onto this seam is the next
 * step toward full paper/live parity.)
 */
export async function executePaperBuy(
  plan: ExecutionPlan,
  openIntent: OpenIntent,
): Promise<TradeExecution> {
  const r = await paperOpen(openIntent);
  if (!r.ok) {
    return {
      positionId: null,
      outcome: toExecutionOutcome(plan, {
        status: r.code === "INSUFFICIENT_BALANCE" ? "rejected" : "failed",
        fillPriceSol: null,
        filledSol: 0,
        rejectReason: r.reason ?? r.code ?? "paper_open_failed",
      }),
    };
  }
  return {
    positionId: r.data.positionId,
    outcome: toExecutionOutcome(plan, {
      status: "filled",
      fillPriceSol: r.data.fillPrice,
      filledSol: plan.intent.sizeSol,
      slippageBpsRealized: r.data.slippageBps,
      filledAtMs: plan.plannedAtMs + (r.data.latencyMs ?? 0),
    }),
  };
}
