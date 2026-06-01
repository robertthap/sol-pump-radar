import "server-only";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";

export async function insertDecisionTrace(row: {
  mint: string;
  stage: string;
  engine?: "A" | "B";
  action?: string | null;
  reason?: string | null;
  vetoes?: string[];
  confidence?: number | null;
  featureSnapshot?: Record<string, unknown> | null;
}): Promise<void> {
  await getDb().execute(sql`
    INSERT INTO decision_trace (mint, stage, engine, action, reason, vetoes, confidence, feature_snapshot)
    VALUES (
      ${row.mint},
      ${row.stage},
      ${row.engine ?? "B"},
      ${row.action ?? null},
      ${row.reason?.slice(0, 2000) ?? null},
      ${JSON.stringify(row.vetoes ?? [])}::jsonb,
      ${row.confidence ?? null},
      ${row.featureSnapshot ? JSON.stringify(row.featureSnapshot) : null}::jsonb
    )
  `);
}

export async function fetchRecentTraces(mint: string, limit = 20) {
  const res = await getDb().execute(sql`
    SELECT stage, engine, action, reason, vetoes, confidence, ts
    FROM decision_trace
    WHERE mint = ${mint}
    ORDER BY ts DESC
    LIMIT ${sql.raw(String(limit))}
  `);
  return (res as unknown as { rows: Array<Record<string, unknown>> }).rows;
}

export type ContinuationDecisionTrace = {
  timestamp: number;
  stage: string;
  outputs: { action: string; score: number };
  inputs: { state: string; rankPercentile: number; rankVelocity: number };
  finalReason: string;
};

export async function fetchContinuationDecisionTraces(
  mint: string,
  limit = 40,
): Promise<ContinuationDecisionTrace[]> {
  try {
    const res = await getDb().execute(sql`
      SELECT ts, stage, action, reason, confidence, feature_snapshot
      FROM decision_trace
      WHERE mint = ${mint}
        AND stage IN ('intelligence_commit', 'engine_a_intelligence', 'engine_b_intelligence', 'state_transition_observe')
      ORDER BY ts DESC
      LIMIT ${Math.min(80, Math.max(1, limit))}
    `);
    type Raw = {
      ts: Date | string;
      stage: string;
      action: string;
      reason: string;
      confidence: number;
      feature_snapshot: unknown;
    };
    const out: ContinuationDecisionTrace[] = [];
    for (const r of (res as unknown as { rows: Raw[] }).rows) {
      const snap = r.feature_snapshot as Record<string, unknown> | null;
      const output = (snap?.output ?? snap) as Record<string, unknown> | undefined;
      out.push({
        timestamp: new Date(r.ts).getTime(),
        stage: r.stage,
        outputs: {
          action: String(output?.signal ?? r.action),
          score: Number(output?.confidence ?? r.confidence ?? 0),
        },
        inputs: {
          state: String(output?.state ?? "cold"),
          rankPercentile: Number(output?.rank_percentile ?? 0.5),
          rankVelocity: 0,
        },
        finalReason: String(output?.reason ?? r.reason ?? ""),
      });
    }
    return out;
  } catch {
    return [];
  }
}

export async function fetchEngineBTraceStageCounts(hours = 1, limit = 12) {
  const res = await getDb().execute(sql`
    SELECT stage, COUNT(*)::int AS n
    FROM decision_trace
    WHERE ts > now() - (${sql.raw(String(hours))} || ' hours')::interval AND engine = 'B'
    GROUP BY stage
    ORDER BY n DESC
    LIMIT ${limit}
  `);
  return (res as unknown as { rows: unknown[] }).rows;
}
