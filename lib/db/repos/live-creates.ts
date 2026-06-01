import "server-only";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { classifyTradeable } from "@/lib/trade/tradeable";

export type LiveCreateRow = {
  id: string;
  ts: string;
  mint: string;
  wallet: string | null;
  symbol: string | null;
  name: string | null;
  signature: string;
  ageSeconds: number;
  vSol: number | null;
  gradScore: number | null;
  rugScore: number | null;
  confluence: number | null;
  action: string | null;
  decisionReason: string | null;
  rugLabel: string | null;
  inactivitySeconds: number | null;
  peakVSol: number | null;
  tradeCount: number;
  buyers5m: number;
  hasBundle: boolean;
  hasSniper: boolean;
  mechanicalUptrend: boolean;
  tradeable: "yes" | "no" | "caution" | "wait";
  tradeableReason: string;
  pumpMultiple: number | null;
};

export async function fetchLiveCreatesEnriched(opts?: {
  limit?: number;
  hours?: number;
}): Promise<LiveCreateRow[]> {
  const limit = Math.min(150, Math.max(10, opts?.limit ?? 60));
  const hours = Math.min(48, Math.max(1, opts?.hours ?? 24));

  const res = await getDb().execute(sql`
    WITH creates AS (
      SELECT
        e.id::text AS id,
        e.ts AS ts,
        e.mint::text AS mint,
        e.wallet::text AS wallet,
        e.signature::text AS signature,
        COALESCE(t.symbol, e.raw->>'symbol') AS symbol,
        COALESCE(t.name, e.raw->>'name') AS name,
        EXTRACT(EPOCH FROM (now() - e.ts))::float8 AS age_seconds
      FROM events e
      LEFT JOIN tokens t ON t.mint = e.mint
      WHERE e.kind = 'create'
        AND e.ts > now() - (${sql.raw(String(hours))} || ' hours')::interval
      ORDER BY e.ts DESC
      LIMIT ${sql.raw(String(limit))}
    ),
    latest_dec AS (
      SELECT DISTINCT ON (d.mint)
        d.mint::text AS mint,
        d.action::text AS action,
        d.confluence_score::float8 AS confluence,
        d.reason_human::text AS reason
      FROM decision_log d
      WHERE d.mint IN (SELECT mint FROM creates)
      ORDER BY d.mint, d.ts DESC
    ),
    latest_feat AS (
      SELECT DISTINCT ON (f.mint)
        f.mint::text AS mint,
        f.v_sol::float8 AS v_sol,
        f.grad_score::float8 AS grad_score,
        f.rug_score::float8 AS rug_score,
        f.confluence_score::float8 AS confluence
      FROM token_features f
      WHERE f.mint IN (SELECT mint FROM creates)
      ORDER BY f.mint, f.ts DESC
    ),
    flow AS (
      SELECT
        e.mint::text AS mint,
        COUNT(*) FILTER (WHERE e.kind IN ('buy','sell'))::int AS trade_count,
        COUNT(DISTINCT e.wallet) FILTER (WHERE e.kind = 'buy' AND e.ts > now() - interval '5 minutes')::int AS buyers_5m,
        MAX(e.v_sol_after)::float8 AS peak_v_sol_live,
        (SELECT v_sol_after::float8 FROM events e2
         WHERE e2.mint = e.mint AND e2.v_sol_after IS NOT NULL
         ORDER BY e2.ts DESC LIMIT 1) AS v_sol_now,
        EXTRACT(EPOCH FROM (now() - MAX(e.ts)))::float8 AS inactivity_sec
      FROM events e
      WHERE e.mint IN (SELECT mint FROM creates)
      GROUP BY e.mint
    ),
    first_v AS (
      SELECT DISTINCT ON (e.mint)
        e.mint::text AS mint,
        e.v_sol_after::float8 AS first_v
      FROM events e
      WHERE e.mint IN (SELECT mint FROM creates)
        AND e.v_sol_after IS NOT NULL
        AND e.v_sol_after > 0
      ORDER BY e.mint, e.ts ASC
    ),
    rug AS (
      SELECT mint, label::text AS label, peak_v_sol, inactivity_seconds
      FROM rug_labels
      WHERE mint IN (SELECT mint FROM creates)
    ),
    bots AS (
      SELECT mint::text AS mint,
        COALESCE(has_bundle, false) AS has_bundle,
        COALESCE(has_sniper, false) AS has_sniper,
        COALESCE(mechanical_uptrend, false) AS mechanical_uptrend
      FROM mint_bot_flags
      WHERE mint IN (SELECT mint FROM creates)
    )
    SELECT
      c.id, c.ts, c.mint, c.wallet, c.symbol, c.name, c.signature, c.age_seconds,
      COALESCE(f.v_sol, fl.v_sol_now) AS v_sol,
      f.grad_score, f.rug_score,
      COALESCE(d.confluence, f.confluence) AS confluence,
      d.action, d.reason AS decision_reason,
      COALESCE(r.label, CASE WHEN c.age_seconds < 600 THEN NULL ELSE 'active' END) AS rug_label,
      COALESCE(r.inactivity_seconds, fl.inactivity_sec) AS inactivity_seconds,
      COALESCE(r.peak_v_sol, fl.peak_v_sol_live) AS peak_v_sol,
      COALESCE(fl.trade_count, 0) AS trade_count,
      COALESCE(fl.buyers_5m, 0) AS buyers_5m,
      COALESCE(b.has_bundle, false) AS has_bundle,
      COALESCE(b.has_sniper, false) AS has_sniper,
      COALESCE(b.mechanical_uptrend, false) AS mechanical_uptrend,
      fv.first_v
    FROM creates c
    LEFT JOIN latest_dec d ON d.mint = c.mint
    LEFT JOIN latest_feat f ON f.mint = c.mint
    LEFT JOIN flow fl ON fl.mint = c.mint
    LEFT JOIN first_v fv ON fv.mint = c.mint
    LEFT JOIN rug r ON r.mint = c.mint
    LEFT JOIN bots b ON b.mint = c.mint
    ORDER BY c.ts DESC
  `);

  type Raw = {
    id: string;
    ts: Date | string;
    mint: string;
    wallet: string | null;
    symbol: string | null;
    name: string | null;
    signature: string;
    age_seconds: number;
    v_sol: number | null;
    grad_score: number | null;
    rug_score: number | null;
    confluence: number | null;
    action: string | null;
    decision_reason: string | null;
    rug_label: string | null;
    inactivity_seconds: number | null;
    peak_v_sol: number | null;
    trade_count: number;
    buyers_5m: number;
    has_bundle: boolean;
    has_sniper: boolean;
    mechanical_uptrend: boolean;
    first_v: number | null;
  };

  return (res as unknown as { rows: Raw[] }).rows.map((r) => {
    const ageSeconds = r.age_seconds ?? 0;
    const peak = r.peak_v_sol;
    const firstV = r.first_v;
    const pumpMultiple =
      peak != null && firstV != null && firstV > 0 ? peak / firstV : null;
    const tradeable = classifyTradeable({
      rugLabel: r.rug_label,
      ageSeconds,
      action: r.action,
      hasBundle: r.has_bundle,
      mechanicalUptrend: r.mechanical_uptrend,
      hasSniper: r.has_sniper,
      tradeCount: r.trade_count,
      confluence: r.confluence,
      inactivitySeconds: r.inactivity_seconds,
      pumpMultiple: pumpMultiple,
    });
    return {
      id: r.id,
      ts: r.ts instanceof Date ? r.ts.toISOString() : String(r.ts),
      mint: r.mint,
      wallet: r.wallet,
      symbol: r.symbol,
      name: r.name,
      signature: r.signature,
      ageSeconds,
      vSol: r.v_sol,
      gradScore: r.grad_score,
      rugScore: r.rug_score,
      confluence: r.confluence,
      action: r.action,
      decisionReason: r.decision_reason,
      rugLabel: r.rug_label,
      inactivitySeconds: r.inactivity_seconds,
      peakVSol: peak,
      tradeCount: r.trade_count,
      buyers5m: r.buyers_5m,
      hasBundle: r.has_bundle,
      hasSniper: r.has_sniper,
      mechanicalUptrend: r.mechanical_uptrend,
      tradeable: tradeable.status,
      tradeableReason: tradeable.reason,
      pumpMultiple,
    };
  });
}
