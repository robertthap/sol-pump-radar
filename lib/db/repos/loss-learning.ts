import "server-only";
import { sql, desc, eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { PAPER_TRADES_READ } from "@/lib/db/paper-read";
import { lossPostmortems, learnedRules } from "@/lib/db/schema";
import { logger } from "@/lib/log";

const log = logger("repo:loss-learning");

/**
 * Snapshot the entry context for any closed losing trade that hasn't been
 * post-morteemed yet. We pull the latest token_features row at-or-before the
 * trade's open_at to reconstruct what the system saw at entry.
 */
export async function attributeLossPostmortems(maxBatch = 100): Promise<number> {
  const res = await getDb().execute(sql`
    WITH closed_losses AS (
      SELECT 'paper'::text AS source, p.id AS trade_id, p.mint::text AS mint,
             p.pnl_sol::float8 AS pnl_sol,
             p.size_sol::float8 AS size_sol,
             p.exit_reason::text AS exit_reason,
             p.opened_at,
             p.modules_at_entry,
             (p.entry_features->>'action')::text AS entry_action
      FROM ${sql.raw(PAPER_TRADES_READ)} p
      WHERE p.status = 'closed'
        AND p.pnl_sol IS NOT NULL
        AND p.pnl_sol < 0
      UNION ALL
      SELECT 'live'::text AS source, l.id AS trade_id, l.mint::text AS mint,
             l.pnl_sol::float8 AS pnl_sol,
             l.size_sol::float8 AS size_sol,
             l.exit_reason::text AS exit_reason,
             l.opened_at,
             l.modules_at_entry,
             (l.entry_features->>'action')::text AS entry_action
      FROM live_trades l
      WHERE l.status = 'closed'
        AND l.pnl_sol IS NOT NULL
        AND l.pnl_sol < 0
    ),
    pending AS (
      SELECT cl.*
      FROM closed_losses cl
      LEFT JOIN loss_postmortems lp
        ON lp.source = cl.source AND lp.trade_id = cl.trade_id
      WHERE lp.id IS NULL
      ORDER BY cl.opened_at DESC
      LIMIT ${sql.raw(String(maxBatch))}
    ),
    enriched AS (
      SELECT p.*,
        EXTRACT(EPOCH FROM (p.opened_at - t.created_at))::float8 AS age_at_entry,
        (
          SELECT row_to_json(f) FROM (
            SELECT v_sol, momentum_score, grad_score, rug_score, confluence_score,
                   (COALESCE(buys_5m,0) + COALESCE(sells_5m,0))::int AS trades_5m,
                   buys_5m, sells_5m, unique_buyers_5m,
                   buy_vol_5m, sell_vol_5m,
                   (extras->>'top3BuyerShare')::float8 AS top3_buyer_share,
                   (extras->>'devSellVolSol')::float8 AS dev_sell_vol_sol
            FROM token_features
            WHERE mint = p.mint
              AND ts <= p.opened_at + interval '30 seconds'
            ORDER BY ts DESC
            LIMIT 1
          ) f
        ) AS feat_at_entry
      FROM pending p
      LEFT JOIN tokens t ON t.mint = p.mint
    )
    INSERT INTO loss_postmortems (
      source, trade_id, mint, pnl_sol, pnl_pct, exit_reason, entry_action,
      features, modules_at_entry, recorded_at
    )
    SELECT source, trade_id, mint, pnl_sol,
           CASE WHEN size_sol > 0 THEN pnl_sol / size_sol ELSE NULL END,
           exit_reason, entry_action,
           json_build_object(
             'age_at_entry', age_at_entry,
             'feat_at_entry', feat_at_entry
           ),
           modules_at_entry,
           now()
    FROM enriched
    RETURNING id
  `);
  type Raw = { id: string | bigint };
  const rows = (res as unknown as { rows: Raw[] }).rows;
  return rows.length;
}

export type FeaturePattern = {
  featureKey: string;
  operator: "<" | ">" | "<=" | ">=";
  threshold: number;
  sampleN: number;
  lossRate: number;
  reason: string;
};

const FEATURE_PATHS: Array<{ key: string; path: string; thresholds: number[]; mode: "lt" | "gt" }> = [
  { key: "feat.unique_buyers_5m", path: "(features->'feat_at_entry'->>'unique_buyers_5m')::float8", thresholds: [3, 5, 8, 12], mode: "lt" },
  { key: "feat.top3_buyer_share", path: "(features->'feat_at_entry'->>'top3_buyer_share')::float8", thresholds: [0.5, 0.6, 0.7, 0.8], mode: "gt" },
  { key: "feat.dev_sell_vol_sol", path: "(features->'feat_at_entry'->>'dev_sell_vol_sol')::float8", thresholds: [0.05, 0.1, 0.25, 0.5], mode: "gt" },
  { key: "feat.age_at_entry", path: "(features->>'age_at_entry')::float8", thresholds: [60, 180, 600], mode: "lt" },
  { key: "feat.sells_5m_over_trades_5m", path: "(features->'feat_at_entry'->>'sells_5m')::float8 / NULLIF((features->'feat_at_entry'->>'trades_5m')::float8, 0)", thresholds: [0.4, 0.5, 0.6], mode: "gt" },
  { key: "module.M1_GRADUATION", path: "(modules_at_entry->>'M1_GRADUATION')::float8", thresholds: [0.4, 0.5, 0.6], mode: "lt" },
  { key: "module.M3_RUG", path: "(modules_at_entry->>'M3_RUG')::float8", thresholds: [0.2, 0.3, 0.4, 0.5], mode: "gt" },
  { key: "module.M2_INSIDER", path: "(modules_at_entry->>'M2_INSIDER')::float8", thresholds: [0.4, 0.5, 0.6], mode: "gt" },
  { key: "module.M4_CREATOR", path: "(modules_at_entry->>'M4_CREATOR')::float8", thresholds: [0.4, 0.5, 0.6], mode: "gt" },
  { key: "module.M5_WASH", path: "(modules_at_entry->>'M5_WASH')::float8", thresholds: [0.3, 0.4, 0.5], mode: "gt" },
  // Bot/ring features (computed by lookup at trade time, not entry context)
  { key: "feat.bundle_ring_buyers", path: "computed", thresholds: [1, 2, 3], mode: "gt" },
  { key: "feat.sniper_ring_buyers", path: "computed", thresholds: [2, 3, 5], mode: "gt" },
  // Three-gate stamps (auto-trader writes these)
  { key: "feat.gate_confidence", path: "computed", thresholds: [0.4, 0.5, 0.6], mode: "lt" },
  { key: "feat.gate_wallet_conf", path: "computed", thresholds: [0.3, 0.4, 0.5], mode: "lt" },
  { key: "feat.gate_coin_conf", path: "computed", thresholds: [0.3, 0.4, 0.5], mode: "lt" },
  { key: "feat.gate_timing_conf", path: "computed", thresholds: [0.3, 0.4, 0.5], mode: "lt" },
  // DexScreener 5m order-flow at entry — the momentum signal for DEX-discovered
  // coins. Low buy/sell ratio, dying volume, or a falling 5m price tend to precede
  // losses; the learner mines these to auto-create avoid rules (and win patterns).
  { key: "feat.dex_buy_sell_ratio", path: "computed", thresholds: [0.5, 0.7, 0.9, 1.0], mode: "lt" },
  { key: "feat.dex_vol_acceleration", path: "computed", thresholds: [0.3, 0.5, 0.8, 1.0], mode: "lt" },
  { key: "feat.dex_price_change_m5", path: "computed", thresholds: [-5, 0, 5], mode: "lt" },
  // Kalacheva et al. 2026 early-window features (stored in token_features.extras)
  { key: "feat.creation_trade_delta", path: "(tf.extras->>'creationTradeDeltaSec')::float8", thresholds: [2, 5, 10, 30], mode: "lt" },
  { key: "feat.total_sol_first_5m", path: "(tf.extras->>'totalSolFirst5m')::float8", thresholds: [0.5, 1, 2, 5], mode: "lt" },
  { key: "feat.rsi_5m", path: "(tf.extras->>'rsi5m')::float8", thresholds: [0.2, 0.3, 0.8, 0.95], mode: "gt" },
  { key: "feat.rsi_std_5m", path: "(tf.extras->>'rsiStd5m')::float8", thresholds: [0.2, 0.25, 0.3], mode: "gt" },
  { key: "feat.pump_multiple", path: "(tf.extras->>'pumpMultiple')::float8", thresholds: [1.5, 2, 2.5, 3], mode: "gt" },
];

const MIN_SAMPLES = 20;
const LOSS_RATE_THRESHOLD = 0.65;
const WIN_RATE_THRESHOLD = 0.6;

export type DsRow = {
  src: string;
  pnl: number;
  age_at_entry: number | null;
  m3: number | null;
  m1: number | null;
  m2: number | null;
  m4: number | null;
  m5: number | null;
  gconf: number | null;
  gwallet: number | null;
  gcoin: number | null;
  gtiming: number | null;
  dex_bsr: number | null;
  dex_volacc: number | null;
  dex_pc5: number | null;
  u5m: number | null;
  t5m: number | null;
  s5m: number | null;
  top3: number | null;
  devsell: number | null;
  ctd: number | null;
  sol5m: number | null;
  rsi5m: number | null;
  rsi_std5m: number | null;
  pump_mult: number | null;
  ring_b: number;
  ring_s: number;
};

function featureValue(r: DsRow, key: string): number | null {
  switch (key) {
    case "feat.unique_buyers_5m": return r.u5m;
    case "feat.top3_buyer_share": return r.top3;
    case "feat.dev_sell_vol_sol": return r.devsell;
    case "feat.age_at_entry": return r.age_at_entry;
    case "feat.sells_5m_over_trades_5m":
      return r.t5m && r.t5m > 0 ? (r.s5m ?? 0) / r.t5m : null;
    case "module.M1_GRADUATION": return r.m1;
    case "module.M3_RUG": return r.m3;
    case "module.M2_INSIDER": return r.m2;
    case "module.M4_CREATOR": return r.m4;
    case "module.M5_WASH": return r.m5;
    case "feat.bundle_ring_buyers": return r.ring_b;
    case "feat.sniper_ring_buyers": return r.ring_s;
    case "feat.gate_confidence": return r.gconf;
    case "feat.gate_wallet_conf": return r.gwallet;
    case "feat.gate_coin_conf": return r.gcoin;
    case "feat.gate_timing_conf": return r.gtiming;
    case "feat.dex_buy_sell_ratio": return r.dex_bsr;
    case "feat.dex_vol_acceleration": return r.dex_volacc;
    case "feat.dex_price_change_m5": return r.dex_pc5;
    case "feat.creation_trade_delta": return r.ctd;
    case "feat.total_sol_first_5m": return r.sol5m;
    case "feat.rsi_5m": return r.rsi5m;
    case "feat.rsi_std_5m": return r.rsi_std5m;
    case "feat.pump_multiple": return r.pump_mult;
    default: return null;
  }
}

/**
 * Materialize the closed-trade dataset (wins + losses) with entry features once,
 * so loss/win univariate splits can be scanned cheaply in JS.
 */
async function fetchClosedTradeDataset(windowHours: number): Promise<DsRow[]> {
  const datasetRes = await getDb().execute(sql`
    WITH all_closed AS (
      SELECT 'paper' AS src, p.id, p.pnl_sol::float8 AS pnl,
        p.modules_at_entry, p.entry_features, p.opened_at, p.mint
      FROM ${sql.raw(PAPER_TRADES_READ)} p
      WHERE p.status='closed' AND p.pnl_sol IS NOT NULL
        AND p.closed_at > now() - (${sql.raw(String(windowHours))} || ' hours')::interval
      UNION ALL
      SELECT 'live' AS src, l.id, l.pnl_sol::float8 AS pnl,
        l.modules_at_entry, l.entry_features, l.opened_at, l.mint
      FROM live_trades l
      WHERE l.status='closed' AND l.pnl_sol IS NOT NULL
        AND l.closed_at > now() - (${sql.raw(String(windowHours))} || ' hours')::interval
    ),
    rings_at_entry AS (
      SELECT a.src, a.id,
        COUNT(*) FILTER (WHERE c.kind = 'bundle_ring')::int AS bundle_ring_buyers,
        COUNT(*) FILTER (WHERE c.kind = 'sniper_ring')::int AS sniper_ring_buyers
      FROM all_closed a
      LEFT JOIN events e
        ON e.mint = a.mint AND e.kind='buy' AND e.wallet IS NOT NULL
        AND e.ts BETWEEN a.opened_at - interval '30 minutes' AND a.opened_at
      LEFT JOIN cluster_members cm ON cm.wallet = e.wallet
      LEFT JOIN clusters c ON c.id = cm.cluster_id
      GROUP BY a.src, a.id
    )
    SELECT a.src, a.pnl,
      EXTRACT(EPOCH FROM (a.opened_at - t.created_at))::float8 AS age_at_entry,
      (a.modules_at_entry->>'M3_RUG')::float8 AS m3,
      (a.modules_at_entry->>'M1_GRADUATION')::float8 AS m1,
      (a.modules_at_entry->>'M2_INSIDER')::float8 AS m2,
      (a.modules_at_entry->>'M4_CREATOR')::float8 AS m4,
      (a.modules_at_entry->>'M5_WASH')::float8 AS m5,
      (a.entry_features->>'gateConfidence')::float8 AS gconf,
      (a.entry_features->>'gateWalletConf')::float8 AS gwallet,
      (a.entry_features->>'gateCoinConf')::float8 AS gcoin,
      (a.entry_features->>'gateTimingConf')::float8 AS gtiming,
      (a.entry_features->>'dexBuySellRatio')::float8 AS dex_bsr,
      (a.entry_features->>'dexVolAcceleration')::float8 AS dex_volacc,
      (a.entry_features->>'dexPriceChangeM5')::float8 AS dex_pc5,
      tf.unique_buyers_5m AS u5m,
      (COALESCE(tf.buys_5m,0) + COALESCE(tf.sells_5m,0))::int AS t5m,
      tf.sells_5m AS s5m,
      (tf.extras->>'top3BuyerShare')::float8 AS top3,
      (tf.extras->>'devSellVolSol')::float8 AS devsell,
      (tf.extras->>'creationTradeDeltaSec')::float8 AS ctd,
      (tf.extras->>'totalSolFirst5m')::float8 AS sol5m,
      (tf.extras->>'rsi5m')::float8 AS rsi5m,
      (tf.extras->>'rsiStd5m')::float8 AS rsi_std5m,
      (tf.extras->>'pumpMultiple')::float8 AS pump_mult,
      COALESCE(re.bundle_ring_buyers, 0) AS ring_b,
      COALESCE(re.sniper_ring_buyers, 0) AS ring_s
    FROM all_closed a
    LEFT JOIN tokens t ON t.mint = a.mint
    LEFT JOIN LATERAL (
      SELECT * FROM token_features f
      WHERE f.mint = a.mint AND f.ts <= a.opened_at + interval '30 seconds'
      ORDER BY f.ts DESC LIMIT 1
    ) tf ON TRUE
    LEFT JOIN rings_at_entry re ON re.src = a.src AND re.id = a.id
  `);
  return (datasetRes as unknown as { rows: DsRow[] }).rows;
}

type SplitStat = {
  featureKey: string;
  operator: FeaturePattern["operator"];
  threshold: number;
  n: number;
  wins: number;
  losses: number;
  sumPnl: number;
};

/** Univariate splits over the dataset with win/loss/pnl tallies per (feature, threshold). */
export function scanSplits(ds: DsRow[]): SplitStat[] {
  const out: SplitStat[] = [];
  for (const f of FEATURE_PATHS) {
    for (const th of f.thresholds) {
      let n = 0;
      let wins = 0;
      let losses = 0;
      let sumPnl = 0;
      for (const row of ds) {
        const v = featureValue(row, f.key);
        if (v == null || !Number.isFinite(v)) continue;
        const matches = f.mode === "lt" ? v < th : v > th;
        if (!matches) continue;
        n++;
        if (row.pnl > 0) wins++;
        else losses++;
        sumPnl += row.pnl;
      }
      if (n < MIN_SAMPLES) continue;
      out.push({
        featureKey: f.key,
        operator: f.mode === "lt" ? "<" : ">",
        threshold: th,
        n,
        wins,
        losses,
        sumPnl,
      });
    }
  }
  return out;
}

/** Mine recent data for univariate splits where loss rate is high (avoid rules). */
export async function mineLossPatterns(windowHours = 24 * 7): Promise<FeaturePattern[]> {
  const ds = await fetchClosedTradeDataset(windowHours);
  if (ds.length < MIN_SAMPLES) return [];
  const out: FeaturePattern[] = [];
  for (const s of scanSplits(ds)) {
    const lossRate = s.losses / s.n;
    if (lossRate < LOSS_RATE_THRESHOLD) continue;
    out.push({
      featureKey: s.featureKey,
      operator: s.operator,
      threshold: s.threshold,
      sampleN: s.n,
      lossRate,
      reason: `${(lossRate * 100).toFixed(0)}% loss rate over ${s.n} trades when ${s.featureKey} ${s.operator} ${s.threshold}`,
    });
  }
  out.sort((a, b) => b.lossRate * b.sampleN - a.lossRate * a.sampleN);
  return out.slice(0, 20);
}

export type WinPattern = {
  featureKey: string;
  operator: FeaturePattern["operator"];
  threshold: number;
  sampleN: number;
  winRate: number;
  avgPnlSol: number;
  reason: string;
};

/**
 * Mine recent data for splits where win rate AND avg PnL are high — "seek"
 * patterns telling the system what actually precedes profit (L5.3).
 */
export async function mineWinningPatterns(windowHours = 24 * 7): Promise<WinPattern[]> {
  const ds = await fetchClosedTradeDataset(windowHours);
  if (ds.length < MIN_SAMPLES) return [];
  const out: WinPattern[] = [];
  for (const s of scanSplits(ds)) {
    const winRate = s.wins / s.n;
    const avgPnl = s.sumPnl / s.n;
    if (winRate < WIN_RATE_THRESHOLD || avgPnl <= 0) continue;
    out.push({
      featureKey: s.featureKey,
      operator: s.operator,
      threshold: s.threshold,
      sampleN: s.n,
      winRate,
      avgPnlSol: avgPnl,
      reason: `${(winRate * 100).toFixed(0)}% win (+${avgPnl.toFixed(4)} SOL avg) over ${s.n} trades when ${s.featureKey} ${s.operator} ${s.threshold}`,
    });
  }
  out.sort((a, b) => b.winRate * b.sampleN - a.winRate * a.sampleN);
  return out.slice(0, 20);
}

export async function recordLearnedRule(p: FeaturePattern, status: "applied" | "proposed"): Promise<bigint | null> {
  // Dedup: same featureKey+operator+threshold within last 24h
  const recent = await getDb().execute(sql`
    SELECT id FROM learned_rules
    WHERE feature_key = ${p.featureKey}
      AND operator = ${p.operator}
      AND threshold = ${p.threshold}
      AND created_at > now() - interval '24 hours'
    LIMIT 1
  `);
  if ((recent as unknown as { rows: unknown[] }).rows.length > 0) return null;
  try {
    const [row] = await getDb()
      .insert(learnedRules)
      .values({
        featureKey: p.featureKey,
        operator: p.operator,
        threshold: p.threshold,
        sampleN: p.sampleN,
        lossRate: p.lossRate,
        status,
        reason: p.reason,
        metrics: { sampleN: p.sampleN, lossRate: p.lossRate },
      })
      .returning({ id: learnedRules.id });
    return row?.id ?? null;
  } catch (e) {
    log.warn("recordLearnedRule failed", { err: String(e) });
    return null;
  }
}

export async function listLearnedRules(limit = 30): Promise<
  Array<{
    id: string;
    createdAt: string;
    featureKey: string;
    operator: string;
    threshold: number;
    sampleN: number;
    lossRate: number;
    status: string;
    reason: string;
  }>
> {
  const rows = await getDb()
    .select()
    .from(learnedRules)
    .orderBy(desc(learnedRules.createdAt))
    .limit(limit);
  return rows.map((r) => ({
    id: r.id.toString(),
    createdAt: r.createdAt.toISOString(),
    featureKey: r.featureKey,
    operator: r.operator,
    threshold: r.threshold,
    sampleN: r.sampleN,
    lossRate: r.lossRate,
    status: r.status,
    reason: r.reason,
  }));
}

export async function setRuleStatus(id: bigint, status: "applied" | "proposed" | "reverted"): Promise<void> {
  await getDb()
    .update(learnedRules)
    .set({ status })
    .where(eq(learnedRules.id, id));
}

/** Active applied avoid rules used by the decision worker. */
export async function fetchActiveAvoidRules(): Promise<Array<{
  id: bigint;
  featureKey: string;
  operator: string;
  threshold: number;
}>> {
  const rows = await getDb()
    .select()
    .from(learnedRules)
    .where(eq(learnedRules.status, "applied"));
  return rows.map((r) => ({
    id: r.id,
    featureKey: r.featureKey,
    operator: r.operator,
    threshold: r.threshold,
  }));
}
