import "server-only";
import { sql } from "drizzle-orm";
import { bootDb, getDb } from "@/lib/db/client";
import { classifyMiss, type MissClassifierInput } from "@/lib/continuation/miss-classifier";
import type { MissType } from "@/lib/continuation/types";
import { fetchTracesForMint } from "@/lib/continuation/trace-store";

export type MintStage =
  | "never_seen"
  | "ui_only"
  | "in_continuation_candidates"
  | "normalized"
  | "state_transition"
  | "ranked_top_n"
  | "event_triggered"
  | "decision_emitted"
  | "ops_dead";

export async function resolveMintStage(mint: string, opsHealthy: boolean): Promise<{
  stage: MintStage;
  missType: MissType;
  detail: string;
}> {
  if (!opsHealthy) {
    return { stage: "ops_dead", missType: "OPS_FAILURE", detail: "worker process not running or stale" };
  }

  await bootDb();
  const db = getDb();

  const cand = await db.execute(sql`
    SELECT momentum_state, rank_percentile, engine_b_action, continuation_score
    FROM continuation_candidates WHERE mint = ${mint} LIMIT 1
  `);
  const cRow = (cand as unknown as {
    rows: Array<{
      momentum_state: string | null;
      rank_percentile: number | null;
      engine_b_action: string | null;
      continuation_score: number;
    }>;
  }).rows[0];

  const traces = await fetchTracesForMint(mint, 30);
  const norm = await db.execute(sql`
    SELECT 1 FROM normalized_snapshots WHERE mint = ${mint} LIMIT 1
  `);
  const hasNorm = ((norm as unknown as { rows: unknown[] }).rows?.length ?? 0) > 0;

  const events = await db.execute(sql`
    SELECT 1 FROM continuation_events WHERE mint = ${mint} AND ts > now() - interval '24 hours' LIMIT 1
  `);
  const hasEvent = ((events as unknown as { rows: unknown[] }).rows?.length ?? 0) > 0;

  const decisions = await db.execute(sql`
    SELECT 1 FROM decision_log
    WHERE mint = ${mint} AND reason_human LIKE 'engine=B%'
      AND ts > now() - interval '24 hours'
    LIMIT 1
  `);
  const hasDecision = ((decisions as unknown as { rows: unknown[] }).rows?.length ?? 0) > 0;

  const missInput: MissClassifierInput = {
    mint,
    expected: "ALERT",
    actual: (cRow?.engine_b_action as MissClassifierInput["actual"]) ?? "NONE",
    inUniverse: !!cRow,
    normalized: hasNorm || !!cRow,
    traces,
    opsHealthy: true,
  };
  const missType = classifyMiss(missInput);

  if (hasDecision) {
    return { stage: "decision_emitted", missType, detail: "Engine B decision in log" };
  }
  if (hasEvent) {
    return { stage: "event_triggered", missType, detail: "continuation_events present" };
  }
  if (cRow && (cRow.rank_percentile ?? 0) >= 0.7) {
    return { stage: "ranked_top_n", missType, detail: `rank=${cRow.rank_percentile}` };
  }
  if (cRow && cRow.momentum_state && cRow.momentum_state !== "cold") {
    return { stage: "state_transition", missType, detail: cRow.momentum_state };
  }
  if (hasNorm || cRow) {
    return { stage: "normalized", missType, detail: "in universe" };
  }
  if (cRow) {
    return { stage: "in_continuation_candidates", missType, detail: "candidate row only" };
  }

  return { stage: "never_seen", missType, detail: "not in continuation_candidates" };
}
