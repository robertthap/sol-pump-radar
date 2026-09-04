import "server-only";
import { getEffectiveSignalMode } from "@/lib/env";
import { sql, desc } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { decisionLog } from "@/lib/db/schema";
import type { DecisionAction } from "@/lib/shared/types";
import { fetchManySmartMoneyCounts } from "@/lib/db/repos/bots";
import { scoreSignal } from "@/lib/signals/quality";
import { attachMissedProfitFields } from "@/lib/signals/missed-profit";
import { getEffectiveTradeLimits } from "@/lib/db/repos/settings";
import { riskBudgetFor } from "@/lib/risk/presets";
import { env } from "@/lib/env";
import type { RiskPreset } from "@/lib/shared/types";

export type DecisionPayload = {
  mint: string;
  action: DecisionAction;
  confluenceScore: number;
  threshold: number;
  modulesFired: string[];
  moduleScores: Record<string, number>;
  vetoes?: string[];
  reasonHuman: string;
  mode: "paper" | "devnet" | "live";
  executed?: string;
  executorReason?: string;
};

export async function insertDecisions(rows: DecisionPayload[]): Promise<number> {
  if (rows.length === 0) return 0;
  await getDb()
    .insert(decisionLog)
    .values(
      rows.map((r) => ({
        mint: r.mint,
        action: r.action,
        confluenceScore: r.confluenceScore,
        threshold: r.threshold,
        modulesFired: r.modulesFired,
        moduleScores: r.moduleScores,
        vetoes: r.vetoes ?? [],
        reasonHuman: r.reasonHuman.slice(0, 510),
        mode: r.mode,
        executed: r.executed ?? "pending",
        executorReason: r.executorReason ?? null,
      })),
    );
  return rows.length;
}

export type LatestDecisionDto = {
  id: string;
  ts: string;
  mint: string;
  action: string;
  confluenceScore: number;
  rugScore: number | null;
  gradScore: number | null;
  reasonHuman: string;
  symbol: string | null;
  name: string | null;
  creator: string | null;
  createdAt: string | null;
};

export async function fetchLatestDecisions(
  limit = 25,
  opts: { includeAvoid?: boolean } = {},
): Promise<LatestDecisionDto[]> {
  const includeAvoid = !!opts.includeAvoid;
  const res = await getDb().execute(sql`
    WITH latest AS (
      SELECT DISTINCT ON (mint)
        id, ts, mint, action, confluence_score, module_scores, reason_human
      FROM decision_log
      WHERE ts > now() - interval '30 minutes'
      ORDER BY mint, ts DESC
    )
    SELECT
      l.id::text AS id,
      l.ts AS ts,
      l.mint::text AS mint,
      l.action::text AS action,
      l.confluence_score::float8 AS confluence_score,
      (l.module_scores->>'M3_RUG')::float8 AS rug_score,
      (l.module_scores->>'M1_GRADUATION')::float8 AS grad_score,
      l.reason_human::text AS reason_human,
      t.symbol::text AS symbol,
      t.name::text AS name,
      t.creator::text AS creator,
      t.created_at AS created_at
    FROM latest l
    LEFT JOIN tokens t ON t.mint = l.mint
    WHERE ${sql.raw(includeAvoid ? "TRUE" : "l.action <> 'AVOID'")}
    ORDER BY
      CASE l.action
        WHEN 'BUY_STRONG' THEN 0
        WHEN 'BUY_MODERATE' THEN 1
        WHEN 'WATCH' THEN 2
        WHEN 'SELL_NOW' THEN 3
        WHEN 'SELL_TP' THEN 4
        WHEN 'AVOID' THEN 5
        ELSE 6
      END,
      l.confluence_score DESC,
      l.ts DESC
    LIMIT ${sql.raw(String(limit))}
  `);
  type Raw = {
    id: string;
    ts: Date | string;
    mint: string;
    action: string;
    confluence_score: number;
    rug_score: number | null;
    grad_score: number | null;
    reason_human: string;
    symbol: string | null;
    name: string | null;
    creator: string | null;
    created_at: Date | string | null;
  };
  const rows = (res as unknown as { rows: Raw[] }).rows;
  return rows.map((r) => ({
    id: r.id,
    ts: r.ts instanceof Date ? r.ts.toISOString() : String(r.ts),
    mint: r.mint,
    action: r.action,
    confluenceScore: r.confluence_score,
    rugScore: r.rug_score,
    gradScore: r.grad_score,
    reasonHuman: r.reason_human ?? "",
    symbol: r.symbol,
    name: r.name,
    creator: r.creator,
    createdAt:
      r.created_at == null
        ? null
        : r.created_at instanceof Date
          ? r.created_at.toISOString()
          : String(r.created_at),
  }));
}

export async function fetchDecisionCounts(): Promise<Record<string, number>> {
  const res = await getDb().execute(sql`
    SELECT action::text AS action, count(*)::int AS n
    FROM decision_log
    WHERE ts > now() - interval '1 hour'
    GROUP BY action
  `);
  const rows = (res as unknown as { rows: Array<{ action: string; n: number }> }).rows;
  const out: Record<string, number> = {};
  for (const r of rows) out[r.action] = r.n;
  return out;
}

export type SignalRow = {
  id: string;
  ts: string;
  mint: string;
  action: string;
  confluenceScore: number;
  gradScore: number | null;
  rugScore: number | null;
  insiderScore: number | null;
  washScore: number | null;
  creatorScore: number | null;
  reasonHuman: string;
  executed: string;
  symbol: string | null;
  name: string | null;
  tokenCreatedAt: string | null;
  vAtSignal: number | null;
  vNow: number | null;
  changePct: number | null;
  rugLabel: string | null;
  vetoes: string[];
  smartMoneyCount: number;
  insiderSignal: boolean;
  qualityScore: number;
  qualityTier: "hot" | "good" | "fair" | "weak" | "avoid";
  tradable: boolean;
  autoReady: boolean;
  executorReason: string | null;
  qualityTags: string[];
  /** From intelligence-commit (single authority). */
  intelligenceCommit: boolean;
  intelligenceEngine: "A" | "B" | null;
  intelligenceSignal: string | null;
  intelligenceState: string | null;
  intelligenceRankPct: number | null;
  autoTradeAllowed: boolean;
  missType: string | null;
  /** Buy recommendation timestamp (same as ts for BUY_* rows). */
  recommendedAt: string | null;
  /** Paper PnL missed since recommendation if you did not enter (SOL). */
  missedProfitSol: number | null;
  /** Paper return % on configured size since recommendation (untraded buys). */
  missedProfitPct: number | null;
};

function parseIntelligenceMeta(
  reasonHuman: string,
  modulesFired: unknown,
  moduleScores: Record<string, number> | null,
): Pick<
  SignalRow,
  | "intelligenceCommit"
  | "intelligenceEngine"
  | "intelligenceSignal"
  | "intelligenceState"
  | "intelligenceRankPct"
  | "autoTradeAllowed"
  | "missType"
> {
  const fired = Array.isArray(modulesFired) ? (modulesFired as string[]) : [];
  const intelligenceCommit =
    fired.includes("ENGINE_INTELLIGENCE") || reasonHuman.includes("fusion=");
  const autoTradeAllowed = (moduleScores?._auto_trade_allowed ?? 0) >= 1;

  let intelligenceEngine: "A" | "B" | null = null;
  if (reasonHuman.includes("engine=A") || fired.includes("ENGINE_A")) intelligenceEngine = "A";
  else if (reasonHuman.includes("engine=B") || fired.includes("ENGINE_B")) intelligenceEngine = "B";

  const signalMatch = reasonHuman.match(/signal=([A-Z_]+)/);
  const intelligenceSignal = signalMatch?.[1] ?? null;
  const stateMatch = reasonHuman.match(/state=([a-z_]+)/);
  const intelligenceState = stateMatch?.[1] ?? null;
  const rankMatch = reasonHuman.match(/rank=([0-9.]+)/);
  const intelligenceRankPct = rankMatch ? Number(rankMatch[1]) : null;
  const missMatch = reasonHuman.match(/miss:([A-Z_]+)/);
  const missType = missMatch?.[1] ?? null;

  return {
    intelligenceCommit,
    intelligenceEngine,
    intelligenceSignal,
    intelligenceState,
    intelligenceRankPct,
    autoTradeAllowed,
    missType,
  };
}

export async function fetchSignalFeed(opts?: {
  hours?: number;
  limit?: number;
  action?: string | null;
  mint?: string | null;
  minScore?: number;
  tradableOnly?: boolean;
  autoReadyOnly?: boolean;
  autoGateOnly?: boolean;
  intelligenceOnly?: boolean;
  engineBOnly?: boolean;
  sortBy?: "time" | "score";
  /** Cap smart-wallet lookups (expensive) — scores use 0 for the rest. */
  smartMoneyCap?: number;
}): Promise<SignalRow[]> {
  const hours = Math.min(168, Math.max(1, opts?.hours ?? 24));
  const limit = Math.min(500, Math.max(10, opts?.limit ?? 100));
  const actionFilter = opts?.action?.trim() || null;
  const mintFilter = opts?.mint?.trim() || null;

  const e = env();
  const [limits, budget] = await Promise.all([
    getEffectiveTradeLimits(),
    Promise.resolve(riskBudgetFor(e.RISK_PRESET as RiskPreset)),
  ]);
  const paperSizeSol = limits.paperSizePerTradeSol;

  const res = await getDb().execute(sql`
    SELECT
      d.id::text AS id,
      d.ts AS ts,
      d.mint::text AS mint,
      d.action::text AS action,
      d.confluence_score::float8 AS confluence_score,
      (d.module_scores->>'M1_GRADUATION')::float8 AS grad_score,
      (d.module_scores->>'M3_RUG')::float8 AS rug_score,
      (d.module_scores->>'M2_INSIDER')::float8 AS insider_score,
      (d.module_scores->>'M5_WASH')::float8 AS wash_score,
      (d.module_scores->>'M4_CREATOR')::float8 AS creator_score,
      d.reason_human::text AS reason_human,
      d.executed::text AS executed,
      d.executor_reason::text AS executor_reason,
      d.modules_fired,
      d.module_scores,
      COALESCE(d.vetoes, '[]'::jsonb) AS vetoes,
      t.symbol::text AS symbol,
      t.name::text AS name,
      t.created_at AS token_created_at,
      lat.v_at_signal,
      vn.v_now,
      rl.label::text AS rug_label
    FROM decision_log d
    LEFT JOIN tokens t ON t.mint = d.mint
    LEFT JOIN rug_labels rl ON rl.mint = d.mint
    LEFT JOIN LATERAL (
      SELECT e.v_sol_after::float8 AS v_at_signal
      FROM events e
      WHERE e.mint = d.mint
        AND e.v_sol_after IS NOT NULL
        AND e.ts <= d.ts + interval '30 seconds'
      ORDER BY e.ts DESC
      LIMIT 1
    ) lat ON TRUE
    LEFT JOIN LATERAL (
      SELECT e.v_sol_after::float8 AS v_now
      FROM events e
      WHERE e.mint = d.mint AND e.v_sol_after IS NOT NULL
      ORDER BY e.ts DESC
      LIMIT 1
    ) vn ON TRUE
    WHERE d.ts > now() - (${sql.raw(String(hours))} || ' hours')::interval
      AND (${actionFilter ? sql`d.action = ${actionFilter}` : sql`TRUE`})
      AND (${mintFilter ? sql`d.mint = ${mintFilter}` : sql`TRUE`})
    ORDER BY d.ts DESC
    LIMIT ${sql.raw(String(limit))}
  `);
  type Raw = {
    id: string;
    ts: Date | string;
    mint: string;
    action: string;
    confluence_score: number;
    grad_score: number | null;
    rug_score: number | null;
    insider_score: number | null;
    wash_score: number | null;
    creator_score: number | null;
    reason_human: string | null;
    executed: string;
    executor_reason: string | null;
    modules_fired: unknown;
    module_scores: Record<string, number> | null;
    vetoes: string[] | unknown;
    symbol: string | null;
    name: string | null;
    token_created_at: Date | string | null;
    v_at_signal: number | null;
    v_now: number | null;
    rug_label: string | null;
  };
  const rows = (res as unknown as { rows: Raw[] }).rows;
  const cap = opts?.smartMoneyCap;
  const mintsForSm =
    cap != null && cap > 0
      ? [...new Set(rows.slice(0, cap).map((r) => r.mint))]
      : [...new Set(rows.map((r) => r.mint))];
  let smartByMint = new Map<string, number>();
  if (mintsForSm.length > 0) {
    try {
      smartByMint = await fetchManySmartMoneyCounts(mintsForSm);
    } catch {
      /* optional */
    }
  }
  let mapped = rows.map((r) => {
    const vAt = r.v_at_signal;
    const vNow = r.v_now;
    const changePct =
      vAt != null && vNow != null && vAt > 0 ? ((vNow - vAt) / vAt) * 100 : null;
    const smartMoneyCount = smartByMint.get(r.mint) ?? 0;
    const reasonHuman = r.reason_human ?? "";
    const moduleScores =
      r.module_scores && typeof r.module_scores === "object"
        ? (r.module_scores as Record<string, number>)
        : null;
    const intel = parseIntelligenceMeta(reasonHuman, r.modules_fired, moduleScores);
    const quality = scoreSignal({
      signalMode: getEffectiveSignalMode(),
      action: r.action,
      confluenceScore: r.confluence_score,
      gradScore: r.grad_score,
      rugScore: r.rug_score,
      insiderScore: r.insider_score,
      washScore: r.wash_score,
      creatorScore: r.creator_score,
      smartMoneyCount,
      rugLabel: r.rug_label,
      vetoes: Array.isArray(r.vetoes) ? (r.vetoes as string[]) : [],
      executed: r.executed,
    });
    const tsIso = r.ts instanceof Date ? r.ts.toISOString() : String(r.ts);
    const missed = attachMissedProfitFields({
      action: r.action,
      executed: r.executed,
      ts: tsIso,
      vAtSignal: vAt,
      vNow: vNow,
      sizeSol: paperSizeSol,
      pumpFeesPct: budget.pumpFeesPct,
      paperSlippagePct: budget.paperSlippagePct,
    });
    return {
      id: r.id,
      ts: tsIso,
      mint: r.mint,
      action: r.action,
      confluenceScore: r.confluence_score,
      gradScore: r.grad_score,
      rugScore: r.rug_score,
      insiderScore: r.insider_score,
      washScore: r.wash_score,
      creatorScore: r.creator_score,
      reasonHuman: r.reason_human ?? "",
      executed: r.executed,
      executorReason: r.executor_reason,
      symbol: r.symbol,
      name: r.name,
      tokenCreatedAt:
        r.token_created_at == null
          ? null
          : r.token_created_at instanceof Date
            ? r.token_created_at.toISOString()
            : String(r.token_created_at),
      vAtSignal: vAt,
      vNow: vNow,
      changePct,
      rugLabel: r.rug_label,
      vetoes: Array.isArray(r.vetoes) ? (r.vetoes as string[]) : [],
      smartMoneyCount,
      insiderSignal: smartMoneyCount >= 1,
      qualityScore: quality.score,
      qualityTier: quality.tier,
      tradable: quality.tradable,
      autoReady: intel.autoTradeAllowed || quality.tags.includes("auto-ready"),
      qualityTags: [
        ...quality.tags,
        ...(intel.intelligenceCommit ? ["intelligence"] : []),
        ...(intel.autoTradeAllowed ? ["auto-gate"] : []),
        ...(reasonHuman.includes("continuation") || reasonHuman.includes("engine=B")
          ? ["continuation"]
          : []),
      ],
      ...intel,
      ...missed,
    };
  });

  const minScore = opts?.minScore;
  if (minScore != null && minScore > 0) {
    mapped = mapped.filter((s) => s.qualityScore >= minScore);
  }
  if (opts?.tradableOnly) {
    mapped = mapped.filter((s) => s.tradable);
  }
  if (opts?.autoReadyOnly) {
    mapped = mapped.filter((s) => s.autoTradeAllowed || s.autoReady);
  }
  if (opts?.autoGateOnly) {
    mapped = mapped.filter((s) => s.autoTradeAllowed);
  }
  if (opts?.intelligenceOnly) {
    mapped = mapped.filter((s) => s.intelligenceCommit);
  }
  if (opts?.engineBOnly) {
    mapped = mapped.filter(
      (s) =>
        s.intelligenceEngine === "B" ||
        s.qualityTags.includes("continuation") ||
        s.reasonHuman.includes("engine=B"),
    );
  }
  if (opts?.sortBy === "score") {
    mapped.sort((a, b) => b.qualityScore - a.qualityScore || b.ts.localeCompare(a.ts));
  }

  return mapped;
}

export async function fetchSignalWinStats(hours = 24): Promise<{
  tracked: number;
  wins: number;
  winRate: number | null;
  avgChangePct: number | null;
}> {
  const res = await getDb().execute(sql`
    WITH sig AS (
      SELECT d.id, d.mint, d.action, d.ts,
        lat.v_at_signal,
        vn.v_now
      FROM decision_log d
      LEFT JOIN LATERAL (
        SELECT e.v_sol_after::float8 AS v_at_signal
        FROM events e
        WHERE e.mint = d.mint AND e.v_sol_after IS NOT NULL AND e.ts <= d.ts + interval '30 seconds'
        ORDER BY e.ts DESC LIMIT 1
      ) lat ON TRUE
      LEFT JOIN LATERAL (
        SELECT e.v_sol_after::float8 AS v_now
        FROM events e WHERE e.mint = d.mint AND e.v_sol_after IS NOT NULL
        ORDER BY e.ts DESC LIMIT 1
      ) vn ON TRUE
      WHERE d.action IN ('BUY_STRONG','BUY_MODERATE')
        AND d.ts > now() - (${sql.raw(String(hours))} || ' hours')::interval
    )
    SELECT
      COUNT(*)::int AS tracked,
      COUNT(*) FILTER (WHERE v_at_signal > 0 AND (v_now - v_at_signal) / v_at_signal > 0.08)::int AS wins,
      AVG(CASE WHEN v_at_signal > 0 THEN ((v_now - v_at_signal) / v_at_signal) * 100 END)::float8 AS avg_change_pct
    FROM sig
    WHERE v_at_signal IS NOT NULL AND v_now IS NOT NULL
  `);
  const r = (res as unknown as { rows: Array<{ tracked: number; wins: number; avg_change_pct: number | null }> }).rows[0];
  if (!r || r.tracked === 0) {
    return { tracked: 0, wins: 0, winRate: null, avgChangePct: null };
  }
  return {
    tracked: r.tracked,
    wins: r.wins,
    winRate: r.wins / r.tracked,
    avgChangePct: r.avg_change_pct,
  };
}

export type ChartSignalMarker = {
  id: string;
  ts: string;
  action: string;
  confluenceScore: number;
  vSol: number | null;
  reason: string;
};

export async function fetchMintSignalMarkers(
  mint: string,
  hours = 24,
): Promise<ChartSignalMarker[]> {
  const rows = await fetchSignalFeed({ mint, hours, limit: 200 });
  return rows.map((r) => ({
    id: r.id,
    ts: r.ts,
    action: r.action,
    confluenceScore: r.confluenceScore,
    vSol: r.vAtSignal,
    reason: r.reasonHuman,
  }));
}
