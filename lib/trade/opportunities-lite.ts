import "server-only";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { scoreSignal } from "@/lib/signals/quality";

export type TradeOpportunity = {
  mint: string;
  action: string;
  confluenceScore: number;
  qualityScore: number;
  qualityTier: string;
  reason: string | null;
  decTs: string;
  vSol: number | null;
  gradScore: number | null;
  rugScore: number | null;
  creatorScore: number | null;
  washScore: number | null;
  insiderScore: number | null;
  momentumScore: number | null;
  symbol: string | null;
  name: string | null;
  ageSeconds: number | null;
  openPaper: number;
  openLive: number;
  buys2m: number;
  sells2m: number;
  buyers5m: number;
  bundleRingBuyers: number;
  sniperRingBuyers: number;
  rugLabel: string;
  smartMoneyCount: number;
  insiderSignal: boolean;
  tradable: boolean;
};

/** Fast opportunities list for trade page (no rings / flow / smart-money joins). */
export async function fetchTradeOpportunitiesLite(
  limit = 24,
  minConf = 0.56,
): Promise<TradeOpportunity[]> {
  const res = await getDb().execute(sql`
    WITH latest_dec AS (
      SELECT DISTINCT ON (mint)
        mint::text AS mint,
        action::text AS action,
        confluence_score::float8 AS confluence_score,
        ts AS dec_ts,
        reason_human::text AS reason
      FROM decision_log
      WHERE action IN ('BUY_STRONG','BUY_MODERATE','WATCH')
        AND ts > now() - interval '30 minutes'
      ORDER BY mint, ts DESC
    ),
    feat AS (
      SELECT DISTINCT ON (mint)
        mint::text AS mint,
        v_sol::float8 AS v_sol,
        grad_score::float8 AS grad_score,
        rug_score::float8 AS rug_score,
        creator_score::float8 AS creator_score,
        wash_score::float8 AS wash_score,
        (extras ->> 'insiderScore')::float8 AS insider_score,
        momentum_score::float8 AS momentum_score
      FROM token_features
      ORDER BY mint, ts DESC
    ),
    rug AS (
      SELECT mint, label::text AS rug_label FROM rug_labels
    )
    SELECT
      d.mint,
      d.action,
      d.confluence_score,
      d.reason,
      to_char(d.dec_ts, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS dec_ts,
      f.v_sol,
      f.grad_score,
      f.rug_score,
      f.creator_score,
      f.wash_score,
      f.insider_score,
      f.momentum_score,
      t.symbol::text AS symbol,
      t.name::text AS name,
      EXTRACT(EPOCH FROM (now() - t.created_at))::float8 AS age_seconds,
      rl.rug_label
    FROM latest_dec d
    LEFT JOIN feat f ON f.mint = d.mint
    LEFT JOIN tokens t ON t.mint = d.mint
    LEFT JOIN rug rl ON rl.mint = d.mint
    WHERE d.confluence_score >= ${minConf}
      AND COALESCE(rl.rug_label, 'active') NOT IN ('rugged', 'stalled')
    ORDER BY
      CASE d.action WHEN 'BUY_STRONG' THEN 0 WHEN 'BUY_MODERATE' THEN 1 ELSE 2 END,
      d.confluence_score DESC
    LIMIT ${sql.raw(String(limit))}
  `);

  type Raw = {
    mint: string;
    action: string;
    confluence_score: number;
    reason: string | null;
    dec_ts: string;
    v_sol: number | null;
    grad_score: number | null;
    rug_score: number | null;
    creator_score: number | null;
    wash_score: number | null;
    insider_score: number | null;
    momentum_score: number | null;
    symbol: string | null;
    name: string | null;
    age_seconds: number | null;
    rug_label: string | null;
  };

  return (res as unknown as { rows: Raw[] }).rows.map((r) => {
    const quality = scoreSignal({
      action: r.action,
      confluenceScore: r.confluence_score,
      gradScore: r.grad_score,
      rugScore: r.rug_score,
      insiderScore: r.insider_score,
      washScore: r.wash_score,
      creatorScore: r.creator_score,
      smartMoneyCount: 0,
      rugLabel: r.rug_label,
    });
    return {
      mint: r.mint,
      action: r.action,
      confluenceScore: r.confluence_score,
      qualityScore: quality.score,
      qualityTier: quality.tier,
      reason: r.reason,
      decTs: r.dec_ts,
      vSol: r.v_sol,
      gradScore: r.grad_score,
      rugScore: r.rug_score,
      creatorScore: r.creator_score,
      washScore: r.wash_score,
      insiderScore: r.insider_score,
      momentumScore: r.momentum_score,
      symbol: r.symbol,
      name: r.name,
      ageSeconds: r.age_seconds,
      openPaper: 0,
      openLive: 0,
      buys2m: 0,
      sells2m: 0,
      buyers5m: 0,
      bundleRingBuyers: 0,
      sniperRingBuyers: 0,
      rugLabel: r.rug_label ?? "active",
      smartMoneyCount: 0,
      insiderSignal: false,
      tradable:
        quality.tradable && (r.rug_label ?? "active") !== "rugged",
    };
  });
}

/** Full opportunities list with rings, flow, and smart-money enrichment. */
export async function fetchTradeOpportunitiesFull(
  limit = 24,
  minConf = 0.56,
): Promise<TradeOpportunity[]> {
  const { PAPER_TRADES_READ } = await import("@/lib/db/paper-read");
  const { fetchManySmartMoneyCounts } = await import("@/lib/db/repos/bots");

  const res = await getDb().execute(sql`
    WITH latest_dec AS (
      SELECT DISTINCT ON (mint)
        mint::text AS mint,
        action::text AS action,
        confluence_score::float8 AS confluence_score,
        ts AS dec_ts,
        reason_human::text AS reason
      FROM decision_log
      WHERE action IN ('BUY_STRONG','BUY_MODERATE','WATCH')
        AND ts > now() - interval '30 minutes'
      ORDER BY mint, ts DESC
    ),
    feat AS (
      SELECT DISTINCT ON (mint)
        mint::text AS mint,
        v_sol::float8 AS v_sol,
        grad_score::float8 AS grad_score,
        rug_score::float8 AS rug_score,
        creator_score::float8 AS creator_score,
        wash_score::float8 AS wash_score,
        (extras ->> 'insiderScore')::float8 AS insider_score,
        momentum_score::float8 AS momentum_score,
        confluence_score::float8 AS conf_now,
        ts AS feat_ts
      FROM token_features
      ORDER BY mint, ts DESC
    ),
    rings AS (
      SELECT
        rb.mint::text AS mint,
        COUNT(*) FILTER (WHERE c.kind = 'bundle_ring')::int AS bundle_ring_buyers,
        COUNT(*) FILTER (WHERE c.kind = 'sniper_ring')::int AS sniper_ring_buyers
      FROM (
        SELECT DISTINCT mint, wallet
        FROM events
        WHERE kind = 'buy' AND wallet IS NOT NULL
          AND ts > now() - interval '30 minutes'
      ) rb
      JOIN cluster_members cm ON cm.wallet = rb.wallet
      JOIN clusters c ON c.id = cm.cluster_id
      GROUP BY rb.mint
    ),
    open_paper AS (
      SELECT mint::text AS mint, COUNT(*)::int AS n
      FROM ${sql.raw(PAPER_TRADES_READ)}
      WHERE status = 'open'
      GROUP BY mint
    ),
    open_live AS (
      SELECT mint::text AS mint, COUNT(*)::int AS n
      FROM live_trades
      WHERE status = 'open'
      GROUP BY mint
    ),
    flow AS (
      SELECT mint::text AS mint,
        COUNT(*) FILTER (WHERE kind = 'buy' AND ts > now() - interval '2 minutes')::int AS buys_2m,
        COUNT(*) FILTER (WHERE kind = 'sell' AND ts > now() - interval '2 minutes')::int AS sells_2m,
        COUNT(DISTINCT wallet) FILTER (WHERE kind = 'buy' AND ts > now() - interval '5 minutes')::int AS buyers_5m
      FROM events
      WHERE ts > now() - interval '15 minutes'
        AND mint IS NOT NULL
      GROUP BY mint
    ),
    rug AS (
      SELECT mint, label::text AS rug_label
      FROM rug_labels
    )
    SELECT
      d.mint,
      d.action,
      d.confluence_score,
      d.reason,
      to_char(d.dec_ts, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS dec_ts,
      f.v_sol,
      f.grad_score,
      f.rug_score,
      f.creator_score,
      f.wash_score,
      f.insider_score,
      f.momentum_score,
      t.symbol::text AS symbol,
      t.name::text AS name,
      EXTRACT(EPOCH FROM (now() - t.created_at))::float8 AS age_seconds,
      COALESCE(op.n, 0) AS open_paper,
      COALESCE(ol.n, 0) AS open_live,
      COALESCE(fl.buys_2m, 0) AS buys_2m,
      COALESCE(fl.sells_2m, 0) AS sells_2m,
      COALESCE(fl.buyers_5m, 0) AS buyers_5m,
      COALESCE(rg.bundle_ring_buyers, 0) AS bundle_ring_buyers,
      COALESCE(rg.sniper_ring_buyers, 0) AS sniper_ring_buyers,
      rl.rug_label
    FROM latest_dec d
    LEFT JOIN feat f ON f.mint = d.mint
    LEFT JOIN tokens t ON t.mint = d.mint
    LEFT JOIN open_paper op ON op.mint = d.mint
    LEFT JOIN open_live ol ON ol.mint = d.mint
    LEFT JOIN flow fl ON fl.mint = d.mint
    LEFT JOIN rings rg ON rg.mint = d.mint
    LEFT JOIN rug rl ON rl.mint = d.mint
    WHERE d.confluence_score >= ${minConf}
      AND COALESCE(rl.rug_label, 'active') NOT IN ('rugged', 'stalled')
    ORDER BY
      CASE d.action WHEN 'BUY_STRONG' THEN 0 WHEN 'BUY_MODERATE' THEN 1 ELSE 2 END,
      d.confluence_score DESC
    LIMIT ${sql.raw(String(limit))}
  `);
  type Raw = {
    mint: string;
    action: string;
    confluence_score: number;
    reason: string | null;
    dec_ts: string;
    v_sol: number | null;
    grad_score: number | null;
    rug_score: number | null;
    creator_score: number | null;
    wash_score: number | null;
    insider_score: number | null;
    momentum_score: number | null;
    symbol: string | null;
    name: string | null;
    age_seconds: number | null;
    open_paper: number;
    open_live: number;
    buys_2m: number;
    sells_2m: number;
    buyers_5m: number;
    bundle_ring_buyers: number;
    sniper_ring_buyers: number;
    rug_label: string | null;
  };
  const rows = (res as unknown as { rows: Raw[] }).rows;
  const smartByMint = await fetchManySmartMoneyCounts(rows.map((r) => r.mint));
  return rows.map((r) => {
    const smartMoneyCount = smartByMint.get(r.mint) ?? 0;
    const quality = scoreSignal({
      action: r.action,
      confluenceScore: r.confluence_score,
      gradScore: r.grad_score,
      rugScore: r.rug_score,
      insiderScore: r.insider_score,
      washScore: r.wash_score,
      creatorScore: r.creator_score,
      smartMoneyCount,
      rugLabel: r.rug_label,
    });
    const tradable =
      quality.tradable &&
      (r.rug_label ?? "active") !== "rugged" &&
      r.bundle_ring_buyers < 2;
    return {
      mint: r.mint,
      action: r.action,
      confluenceScore: r.confluence_score,
      qualityScore: quality.score,
      qualityTier: quality.tier,
      reason: r.reason,
      decTs: r.dec_ts,
      vSol: r.v_sol,
      gradScore: r.grad_score,
      rugScore: r.rug_score,
      creatorScore: r.creator_score,
      washScore: r.wash_score,
      insiderScore: r.insider_score,
      momentumScore: r.momentum_score,
      symbol: r.symbol,
      name: r.name,
      ageSeconds: r.age_seconds,
      openPaper: r.open_paper,
      openLive: r.open_live,
      buys2m: r.buys_2m,
      sells2m: r.sells_2m,
      buyers5m: r.buyers_5m,
      bundleRingBuyers: r.bundle_ring_buyers,
      sniperRingBuyers: r.sniper_ring_buyers,
      rugLabel: r.rug_label ?? "active",
      smartMoneyCount,
      insiderSignal: smartMoneyCount >= 1,
      tradable,
    };
  });
}
