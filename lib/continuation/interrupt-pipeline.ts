import "server-only";
import { sql } from "drizzle-orm";
import type { EngineBResult } from "@/lib/continuation/types";
import {
  detectStateTransition,
  resolveTransitionEmit,
  type StateTransition,
} from "@/lib/continuation/state-transition-alerts";
import { getPriorState } from "@/lib/continuation/state-registry";
import { insertDecisionTrace } from "@/lib/db/repos/decision-trace";
import { getDb } from "@/lib/db/client";

export type InterruptContext = {
  eventKind?: "volume_spike" | "liquidity_jump" | "rank_jump" | "price_burst" | "new_pool" | "state_change";
  rankJump?: number;
};

/** Observe transitions only — no decision_log emits (intelligence-commit owns that). */
export async function processEngineBInterrupt(
  result: EngineBResult,
  opts?: InterruptContext,
): Promise<{ emitted: boolean; transition: StateTransition | null }> {
  const prior = getPriorState(result.mint);
  let transition = detectStateTransition(prior, result.state);

  if (!transition && opts?.eventKind && opts.eventKind !== "state_change") {
    transition = {
      from: prior,
      to: result.state,
      kind: opts.eventKind === "rank_jump" ? "rank_jump" : "event_spike",
    };
  }

  if (!transition) return { emitted: false, transition: null };

  const emitAction = resolveTransitionEmit(transition, result);
  await recordTransitionHistory(result.mint, transition, emitAction);
  return { emitted: false, transition };
}

async function recordTransitionHistory(
  mint: string,
  transition: StateTransition,
  emitAction: string,
) {
  try {
    await getDb().execute(sql`
      INSERT INTO momentum_state_history (mint, from_state, to_state, reason)
      VALUES (
        ${mint},
        ${transition.from},
        ${transition.to},
        ${`observe:${emitAction}:${transition.kind}`}
      )
    `);
    await insertDecisionTrace({
      mint,
      stage: "state_transition_observe",
      engine: "B",
      action: emitAction,
      reason: `${transition.from}→${transition.to}|${transition.kind}`,
      confidence: 1,
      featureSnapshot: { transition, emitAction },
    });
  } catch {
    /* optional tables */
  }
}
