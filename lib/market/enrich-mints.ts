import "server-only";
import { getEffectiveSignalMode } from "@/lib/env";

import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { fetchManyMintFlags, fetchManySmartMoneyCounts } from "@/lib/db/repos/bots";
import { actionLabel, derivePrimaryFlag } from "@/lib/market/flags";
import type { MarketCoinAnalysis } from "@/lib/market/types";
import { scoreSignal } from "@/lib/signals/quality";
import { classifyTradeable } from "@/lib/trade/tradeable";

const EMPTY: MarketCoinAnalysis = {
  action: null,
  actionLabel: "Scanning",
  confluenceScore: null,
  gradScore: null,
  rugScore: null,
  qualityScore: 0,
  qualityTier: "weak",
  tradable: false,
  tradeableStatus: "wait",
  tradeableReason: "Waiting for radar scan",
  rugLabel: null,
  hasBundle: false,
  hasSniper: false,
  mechanicalUptrend: false,
  smartMoneyCount: 0,
  tags: [],
  primaryFlag: "scanning",
  flagLabel: "Scanning…",
};

export async function enrichMarketMints(
  mints: string[],
): Promise<Map<string, MarketCoinAnalysis>> {
  const unique = [...new Set(mints.filter(Boolean))];
  const out = new Map<string, MarketCoinAnalysis>();
  if (!unique.length) return out;

  for (const mint of unique) out.set(mint, { ...EMPTY });

  const mintList = sql.join(
    unique.map((m) => sql`${m}`),
    sql`, `,
  );

  const res = await getDb().execute(sql`
    WITH mints AS (
      SELECT unnest(ARRAY[${mintList}]::text[]) AS mint
    ),
    latest_dec AS (
      SELECT DISTINCT ON (d.mint)
        d.mint::text AS mint,
        d.action::text AS action,
        d.confluence_score::float8 AS confluence,
        (d.module_scores->>'M1_GRADUATION')::float8 AS grad_score,
        (d.module_scores->>'M3_RUG')::float8 AS rug_score,
        (d.module_scores->>'M2_INSIDER')::float8 AS insider_score,
        (d.module_scores->>'M5_WASH')::float8 AS wash_score,
        (d.module_scores->>'M4_CREATOR')::float8 AS creator_score,
        d.reason_human::text AS reason,
        d.executed::text AS executed,
        COALESCE(d.vetoes, '[]'::jsonb) AS vetoes
      FROM decision_log d
      WHERE d.mint::text IN (SELECT mint FROM mints)
      ORDER BY d.mint, d.ts DESC
    ),
    latest_feat AS (
      SELECT DISTINCT ON (f.mint)
        f.mint::text AS mint,
        f.grad_score::float8 AS grad_score,
        f.rug_score::float8 AS rug_score,
        f.confluence_score::float8 AS confluence
      FROM token_features f
      WHERE f.mint::text IN (SELECT mint FROM mints)
      ORDER BY f.mint, f.ts DESC
    ),
    mints_with_events AS (
      SELECT DISTINCT e.mint::text AS mint
      FROM events e
      WHERE e.mint::text IN (SELECT mint FROM mints)
    ),
    flow AS (
      SELECT
        e.mint::text AS mint,
        COUNT(*) FILTER (WHERE e.kind IN ('buy','sell'))::int AS trade_count,
        EXTRACT(EPOCH FROM (now() - MAX(e.ts)))::float8 AS inactivity_sec,
        MAX(e.v_sol_after)::float8 AS peak_v_sol
      FROM events e
      WHERE e.mint::text IN (SELECT mint FROM mints_with_events)
      GROUP BY e.mint
    ),
    first_v AS (
      SELECT DISTINCT ON (e.mint)
        e.mint::text AS mint,
        e.v_sol_after::float8 AS first_v
      FROM events e
      WHERE e.mint::text IN (SELECT mint FROM mints_with_events)
        AND e.v_sol_after IS NOT NULL AND e.v_sol_after > 0
      ORDER BY e.mint, e.ts ASC
    ),
    rug AS (
      SELECT mint::text AS mint, label::text AS label
      FROM rug_labels
      WHERE mint::text IN (SELECT mint FROM mints)
    )
    SELECT
      m.mint,
      d.action,
      COALESCE(d.confluence, f.confluence) AS confluence,
      COALESCE(d.grad_score, f.grad_score) AS grad_score,
      COALESCE(d.rug_score, f.rug_score) AS rug_score,
      d.insider_score,
      d.wash_score,
      d.creator_score,
      d.reason,
      d.executed,
      d.vetoes,
      r.label AS rug_label,
      COALESCE(fl.trade_count, 0) AS trade_count,
      fl.inactivity_sec,
      fl.peak_v_sol,
      fv.first_v,
      t.created_at AS token_created_at
    FROM mints m
    LEFT JOIN latest_dec d ON d.mint = m.mint
    LEFT JOIN latest_feat f ON f.mint = m.mint
    LEFT JOIN flow fl ON fl.mint = m.mint
    LEFT JOIN first_v fv ON fv.mint = m.mint
    LEFT JOIN rug r ON r.mint = m.mint
    LEFT JOIN tokens t ON t.mint::text = m.mint
  `);

  type Raw = {
    mint: string;
    action: string | null;
    confluence: number | null;
    grad_score: number | null;
    rug_score: number | null;
    insider_score: number | null;
    wash_score: number | null;
    creator_score: number | null;
    reason: string | null;
    executed: string | null;
    vetoes: string[] | unknown;
    rug_label: string | null;
    trade_count: number;
    inactivity_sec: number | null;
    peak_v_sol: number | null;
    first_v: number | null;
    token_created_at: Date | string | null;
  };

  const rows = (res as unknown as { rows: Raw[] }).rows;
  const rowMints = rows.map((r) => r.mint);

  let flagsByMint = new Map<string, { hasBundle: boolean; hasSniper: boolean; mechanicalUptrend: boolean }>();
  let smartByMint = new Map<string, number>();
  try {
    flagsByMint = await fetchManyMintFlags(rowMints);
    smartByMint = await fetchManySmartMoneyCounts(rowMints.slice(0, 60));
  } catch {
    /* optional */
  }

  for (const r of rows) {
    const flags = flagsByMint.get(r.mint) ?? {
      hasBundle: false,
      hasSniper: false,
      mechanicalUptrend: false,
    };
    const smartMoneyCount = smartByMint.get(r.mint) ?? 0;
    const peak = r.peak_v_sol;
    const firstV = r.first_v;
    const pumpMultiple =
      peak != null && firstV != null && firstV > 0 ? peak / firstV : null;
    const ageSeconds =
      r.token_created_at == null
        ? 0
        : (Date.now() -
            new Date(
              r.token_created_at instanceof Date
                ? r.token_created_at
                : String(r.token_created_at),
            ).getTime()) /
          1000;

    const tradeable = classifyTradeable({
      rugLabel: r.rug_label,
      ageSeconds,
      action: r.action,
      hasBundle: flags.hasBundle,
      mechanicalUptrend: flags.mechanicalUptrend,
      hasSniper: flags.hasSniper,
      tradeCount: r.trade_count,
      confluence: r.confluence,
      inactivitySeconds: r.inactivity_sec,
      pumpMultiple,
      insiderSignal: smartMoneyCount >= 2,
    });

    const quality = scoreSignal({
      signalMode: getEffectiveSignalMode(),
      action: r.action ?? "WATCH",
      confluenceScore: r.confluence ?? 0,
      gradScore: r.grad_score,
      rugScore: r.rug_score,
      insiderScore: r.insider_score,
      washScore: r.wash_score,
      creatorScore: r.creator_score,
      smartMoneyCount,
      rugLabel: r.rug_label,
      vetoes: Array.isArray(r.vetoes) ? (r.vetoes as string[]) : [],
      executed: r.executed ?? undefined,
    });

    const hasScores =
      r.action != null ||
      r.grad_score != null ||
      r.rug_score != null ||
      r.confluence != null;
    const hasLocalEvents = r.trade_count > 0;

    const { primaryFlag, flagLabel } = derivePrimaryFlag({
      action: r.action,
      tradable: quality.tradable,
      tradeableStatus: tradeable.status,
      rugLabel: r.rug_label,
      qualityTier: quality.tier,
      hasScores,
      hasLocalEvents,
    });

    out.set(r.mint, {
      action: r.action,
      actionLabel: actionLabel(r.action),
      confluenceScore: r.confluence,
      gradScore: r.grad_score,
      rugScore: r.rug_score,
      qualityScore: quality.score,
      qualityTier: quality.tier,
      tradable: quality.tradable,
      tradeableStatus: tradeable.status,
      tradeableReason: tradeable.reason,
      rugLabel: r.rug_label,
      hasBundle: flags.hasBundle,
      hasSniper: flags.hasSniper,
      mechanicalUptrend: flags.mechanicalUptrend,
      smartMoneyCount,
      tags: quality.tags,
      primaryFlag,
      flagLabel,
    });
  }

  return out;
}
