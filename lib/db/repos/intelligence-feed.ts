import "server-only";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import type {
  IntelligenceCommitRow,
  IntelligenceFeedStats,
  IntelligenceSignalPublic,
} from "@/lib/intelligence/public-types";

function parseOutput(snapshot: unknown): Partial<IntelligenceCommitRow> | null {
  if (!snapshot || typeof snapshot !== "object") return null;
  const s = snapshot as Record<string, unknown>;
  const output = (s.output ?? s) as Record<string, unknown>;
  if (!output.mint) return null;
  const events = output.trigger_events;
  const trigger_events = Array.isArray(events)
    ? events.map((e) => {
        const ev = e as { kind?: string };
        return ev.kind ?? "event";
      })
    : [];
  const fusion = s.fusion as Record<string, unknown> | undefined;
  const fusion_summary =
    fusion && typeof fusion.fusionReason === "string" ? String(fusion.fusionReason) : null;

  return {
    mint: String(output.mint),
    engine: (output.engine === "A" ? "A" : "B") as "A" | "B",
    state: String(output.state ?? "cold"),
    signal: String(output.signal ?? "NONE") as IntelligenceSignalPublic,
    rank_percentile: Number(output.rank_percentile ?? 0),
    auto_trade_allowed: Boolean(output.auto_trade_allowed),
    confidence: Number(output.confidence ?? 0),
    reason: String(output.reason ?? ""),
    miss_type: output.miss_type ? String(output.miss_type) : null,
    trigger_events,
    fusion_summary,
  };
}

export async function fetchIntelligenceCommits(
  limit = 40,
  mint?: string | null,
): Promise<IntelligenceCommitRow[]> {
  const cap = Math.min(100, Math.max(5, limit));
  const res = await getDb().execute(sql`
    SELECT
      dt.mint,
      dt.ts,
      dt.engine,
      dt.action AS legacy_action,
      dt.reason,
      dt.confidence,
      dt.feature_snapshot
    FROM decision_trace dt
    WHERE dt.stage = 'intelligence_commit'
      AND dt.ts > now() - interval '24 hours'
      AND (${mint ? sql`dt.mint = ${mint}` : sql`TRUE`})
    ORDER BY dt.ts DESC
    LIMIT ${sql.raw(String(cap))}
  `);

  type Raw = {
    mint: string;
    ts: Date | string;
    engine: string;
    legacy_action: string;
    reason: string;
    confidence: number;
    feature_snapshot: unknown;
  };

  const rows = (res as unknown as { rows: Raw[] }).rows;
  const out: IntelligenceCommitRow[] = [];

  for (const r of rows) {
    const parsed = parseOutput(r.feature_snapshot);
    out.push({
      mint: r.mint,
      ts: r.ts instanceof Date ? r.ts.toISOString() : String(r.ts),
      engine: (parsed?.engine ?? (r.engine === "A" ? "A" : "B")) as "A" | "B",
      state: parsed?.state ?? "—",
      signal: parsed?.signal ?? "NONE",
      rank_percentile: parsed?.rank_percentile ?? 0,
      auto_trade_allowed: parsed?.auto_trade_allowed ?? false,
      confidence: parsed?.confidence ?? r.confidence ?? 0,
      reason: parsed?.reason ?? r.reason ?? "",
      miss_type: parsed?.miss_type ?? null,
      legacy_action: r.legacy_action,
      executed_hint: null,
      trigger_events: parsed?.trigger_events ?? [],
      fusion_summary: parsed?.fusion_summary ?? null,
    });
  }

  return out;
}

export async function fetchIntelligenceFeedStats(): Promise<IntelligenceFeedStats> {
  const res = await getDb().execute(sql`
    SELECT
      COUNT(*)::int AS commits_last_hour,
      COUNT(*) FILTER (
        WHERE (feature_snapshot->'output'->>'auto_trade_allowed')::boolean = true
      )::int AS auto_eligible_last_hour,
      COUNT(*) FILTER (WHERE engine = 'A')::int AS engine_a_count,
      COUNT(*) FILTER (WHERE engine = 'B')::int AS engine_b_count
    FROM decision_trace
    WHERE stage = 'intelligence_commit'
      AND ts > now() - interval '1 hour'
  `);
  const row = (res as unknown as { rows: IntelligenceFeedStats[] }).rows[0];
  return (
    row ?? {
      commits_last_hour: 0,
      auto_eligible_last_hour: 0,
      engine_a_count: 0,
      engine_b_count: 0,
    }
  );
}
