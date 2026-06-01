import "server-only";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { tokenFeatures } from "@/lib/db/schema";
import type { TokenFeatureModuleScores } from "@/lib/intelligence/scored-mint-adapter";
import { logger } from "@/lib/log";
import { activeMintWindowMinutes } from "@/lib/env";

const log = logger("repo:features");

export type MintFeatureRow = {
  mint: string;
  creator: string | null;
  ageSeconds: number | null;
  trades5m: number;
  buys5m: number;
  sells5m: number;
  buyVol5m: number;
  sellVol5m: number;
  uniqueBuyers5m: number;
  currentVSol: number | null;
  vSol5mAgo: number | null;
  peakVSol: number | null;
  top3BuyerShare: number | null;
  devSellVolSol: number;
  totalBuyVolSol: number;
  // ---- new (Kalacheva et al. 2026) features ----
  /** Seconds between token creation and first observed swap. Long delays
   *  (>~30s) correlate with legitimacy (team building hype before launch). */
  creationTradeDeltaSec: number | null;
  /** RSI proxy on 1-minute buy_vol / total_vol over the first 5 minutes. */
  rsi5m: number | null;
  /** Standard deviation of the per-minute RSI proxy (volatility of momentum). */
  rsiStd5m: number | null;
  /** Total SOL traded in the first 5 minutes (Kalacheva's top-importance feature). */
  totalSolFirst5m: number | null;
  /** First observed pool SOL (bonding curve) for this mint. */
  firstVSol: number | null;
  /** currentVSol / firstVSol — high values mean late chase / pump-trap risk. */
  pumpMultiple: number | null;
  // ---- bot flags (joined from mint_bot_flags) ------------------------------
  bundleWalletCount: number;
  sniperWalletCount: number;
  bumpWalletCount: number;
  earlyUniqueBuyers: number;
  hasBundle: boolean;
  hasSniper: boolean;
  hasBumpBot: boolean;
  mechanicalUptrend: boolean;
  // ---- creator history (joined from creator_features over launches) -------
  creatorLaunches: number;
  creatorGraduations: number;
  creatorRugs: number;
  creatorSpam: number | null;
  creatorMedianTimeToDumpSec: number | null;
};

export async function computeActiveFeatures(): Promise<MintFeatureRow[]> {
  const windowMin = activeMintWindowMinutes();
  const res = await getDb().execute(sql`
    WITH active AS (
      SELECT DISTINCT mint
      FROM events
      WHERE mint IS NOT NULL
        AND ts > now() - (${sql.raw(String(windowMin))} || ' minutes')::interval
      UNION
      SELECT mint
      FROM trend_candidates
      WHERE updated_at > now() - interval '30 minutes'
      UNION
      SELECT mint
      FROM continuation_candidates
      WHERE updated_at > now() - interval '30 minutes'
    ),
    agg AS (
      SELECT
        e.mint AS mint,
        COUNT(*) FILTER (WHERE e.kind IN ('buy','sell') AND e.ts > now() - interval '5 minutes')::int AS trades_5m,
        COUNT(*) FILTER (WHERE e.kind = 'buy' AND e.ts > now() - interval '5 minutes')::int AS buys_5m,
        COUNT(*) FILTER (WHERE e.kind = 'sell' AND e.ts > now() - interval '5 minutes')::int AS sells_5m,
        COALESCE(SUM(e.sol_amount) FILTER (WHERE e.kind = 'buy' AND e.ts > now() - interval '5 minutes'), 0)::float8 AS buy_vol_5m,
        COALESCE(SUM(e.sol_amount) FILTER (WHERE e.kind = 'sell' AND e.ts > now() - interval '5 minutes'), 0)::float8 AS sell_vol_5m,
        COUNT(DISTINCT e.wallet) FILTER (WHERE e.kind = 'buy' AND e.ts > now() - interval '5 minutes')::int AS unique_buyers_5m,
        MAX(e.v_sol_after)::float8 AS peak_v_sol,
        COALESCE(SUM(e.sol_amount) FILTER (WHERE e.kind = 'buy'), 0)::float8 AS total_buy_vol
      FROM events e
      WHERE e.mint IN (SELECT mint FROM active)
      GROUP BY e.mint
    ),
    current_vsol AS (
      SELECT DISTINCT ON (e.mint) e.mint AS mint, e.v_sol_after::float8 AS v_sol
      FROM events e
      WHERE e.mint IN (SELECT mint FROM active) AND e.v_sol_after IS NOT NULL
      ORDER BY e.mint, e.ts DESC
    ),
    vsol_5m_ago AS (
      SELECT DISTINCT ON (e.mint) e.mint AS mint, e.v_sol_after::float8 AS v_sol
      FROM events e
      WHERE e.mint IN (SELECT mint FROM active)
        AND e.v_sol_after IS NOT NULL
        AND e.ts <= now() - interval '5 minutes'
      ORDER BY e.mint, e.ts DESC
    ),
    buyer_totals AS (
      SELECT mint, wallet, SUM(sol_amount)::float8 AS vol
      FROM events
      WHERE mint IN (SELECT mint FROM active)
        AND kind = 'buy'
        AND ts > now() - (${sql.raw(String(windowMin))} || ' minutes')::interval
        AND wallet IS NOT NULL
      GROUP BY mint, wallet
    ),
    buyer_ranked AS (
      SELECT mint, wallet, vol,
        ROW_NUMBER() OVER (PARTITION BY mint ORDER BY vol DESC) AS rk,
        SUM(vol) OVER (PARTITION BY mint) AS total_vol
      FROM buyer_totals
    ),
    top3 AS (
      SELECT mint,
        (SUM(vol) FILTER (WHERE rk <= 3) / NULLIF(MAX(total_vol), 0))::float8 AS top3_share
      FROM buyer_ranked
      GROUP BY mint
    ),
    dev_sells AS (
      SELECT e.mint AS mint, COALESCE(SUM(e.sol_amount), 0)::float8 AS dev_sell_vol
      FROM events e
      JOIN tokens t ON t.mint = e.mint
      WHERE e.mint IN (SELECT mint FROM active)
        AND e.kind = 'sell'
        AND t.creator IS NOT NULL
        AND e.wallet = t.creator
      GROUP BY e.mint
    ),
    first_trade AS (
      SELECT e.mint AS mint, MIN(e.ts) AS first_ts
      FROM events e
      WHERE e.mint IN (SELECT mint FROM active)
        AND e.kind IN ('buy','sell')
      GROUP BY e.mint
    ),
    -- Per-minute buy fraction within first 5 minutes after token creation.
    -- Used to compute an RSI-like momentum proxy.
    first_5m_window AS (
      SELECT
        e.mint AS mint,
        date_trunc('minute', e.ts) AS minute_ts,
        SUM(e.sol_amount) FILTER (WHERE e.kind = 'buy')::float8  AS buy_vol,
        SUM(e.sol_amount) FILTER (WHERE e.kind = 'sell')::float8 AS sell_vol
      FROM events e
      JOIN tokens t ON t.mint = e.mint
      WHERE e.mint IN (SELECT mint FROM active)
        AND e.kind IN ('buy','sell')
        AND e.ts <= t.created_at + interval '5 minutes'
      GROUP BY e.mint, date_trunc('minute', e.ts)
    ),
    rsi_agg AS (
      SELECT mint,
        AVG( CASE WHEN (COALESCE(buy_vol,0) + COALESCE(sell_vol,0)) > 0
                   THEN COALESCE(buy_vol,0) / (COALESCE(buy_vol,0) + COALESCE(sell_vol,0))
                   ELSE 0.5 END )::float8                   AS rsi_avg,
        STDDEV_POP( CASE WHEN (COALESCE(buy_vol,0) + COALESCE(sell_vol,0)) > 0
                          THEN COALESCE(buy_vol,0) / (COALESCE(buy_vol,0) + COALESCE(sell_vol,0))
                          ELSE 0.5 END )::float8           AS rsi_std,
        SUM(COALESCE(buy_vol,0) + COALESCE(sell_vol,0))::float8 AS total_sol_first_5m
      FROM first_5m_window
      GROUP BY mint
    ),
    first_vsol AS (
      SELECT DISTINCT ON (e.mint)
        e.mint AS mint,
        e.v_sol_after::float8 AS first_v
      FROM events e
      WHERE e.mint IN (SELECT mint FROM active)
        AND e.v_sol_after IS NOT NULL
        AND e.v_sol_after > 0
      ORDER BY e.mint, e.ts ASC
    )
    SELECT
      a.mint::text AS mint,
      t.creator::text AS creator,
      EXTRACT(EPOCH FROM (now() - t.created_at))::float8 AS age_seconds,
      a.trades_5m, a.buys_5m, a.sells_5m,
      a.buy_vol_5m, a.sell_vol_5m,
      a.unique_buyers_5m,
      cv.v_sol AS current_v_sol,
      v5.v_sol AS v_sol_5m_ago,
      a.peak_v_sol,
      tp.top3_share,
      COALESCE(ds.dev_sell_vol, 0) AS dev_sell_vol_sol,
      a.total_buy_vol AS total_buy_vol_sol,
      COALESCE(mbf.bundle_wallet_count, 0)::int AS bundle_wallet_count,
      COALESCE(mbf.sniper_wallet_count, 0)::int AS sniper_wallet_count,
      COALESCE(mbf.bump_wallet_count,   0)::int AS bump_wallet_count,
      COALESCE(mbf.early_unique_buyers, 0)::int AS early_unique_buyers,
      COALESCE(mbf.has_bundle,         false)   AS has_bundle,
      COALESCE(mbf.has_sniper,         false)   AS has_sniper,
      COALESCE(mbf.has_bump_bot,       false)   AS has_bump_bot,
      COALESCE(mbf.mechanical_uptrend, false)   AS mechanical_uptrend,
      COALESCE(cf.launches,            0)::int  AS creator_launches,
      COALESCE(cf.graduations,         0)::int  AS creator_graduations,
      COALESCE(cf.rugs,                0)::int  AS creator_rugs,
      cf.spam_score::float8                       AS creator_spam,
      cf.median_time_to_dump_sec::float8          AS creator_median_time_to_dump_sec,
      EXTRACT(EPOCH FROM (ft.first_ts - t.created_at))::float8 AS creation_trade_delta_sec,
      ra.rsi_avg                                  AS rsi5m,
      ra.rsi_std                                  AS rsi_std5m,
      ra.total_sol_first_5m                       AS total_sol_first_5m,
      fv.first_v                                  AS first_v_sol
    FROM agg a
    LEFT JOIN tokens t ON t.mint = a.mint
    LEFT JOIN current_vsol cv ON cv.mint = a.mint
    LEFT JOIN vsol_5m_ago v5 ON v5.mint = a.mint
    LEFT JOIN top3 tp ON tp.mint = a.mint
    LEFT JOIN dev_sells ds ON ds.mint = a.mint
    LEFT JOIN mint_bot_flags mbf ON mbf.mint = a.mint
    LEFT JOIN creator_features cf ON cf.creator = t.creator
    LEFT JOIN first_trade ft ON ft.mint = a.mint
    LEFT JOIN rsi_agg ra ON ra.mint = a.mint
    LEFT JOIN first_vsol fv ON fv.mint = a.mint
    WHERE a.trades_5m > 0
      OR a.unique_buyers_5m > 0
      OR EXISTS (
        SELECT 1 FROM trend_candidates tc
        WHERE tc.mint = a.mint
          AND tc.updated_at > now() - interval '30 minutes'
          AND (tc.last_trade_at IS NULL OR tc.last_trade_at > now() - interval '30 minutes')
      )
  `);
  type Raw = {
    mint: string;
    creator: string | null;
    age_seconds: number | null;
    trades_5m: number;
    buys_5m: number;
    sells_5m: number;
    buy_vol_5m: number;
    sell_vol_5m: number;
    unique_buyers_5m: number;
    current_v_sol: number | null;
    v_sol_5m_ago: number | null;
    peak_v_sol: number | null;
    top3_share: number | null;
    dev_sell_vol_sol: number;
    total_buy_vol_sol: number;
    bundle_wallet_count: number;
    sniper_wallet_count: number;
    bump_wallet_count: number;
    early_unique_buyers: number;
    has_bundle: boolean;
    has_sniper: boolean;
    has_bump_bot: boolean;
    mechanical_uptrend: boolean;
    creator_launches: number;
    creator_graduations: number;
    creator_rugs: number;
    creator_spam: number | null;
    creator_median_time_to_dump_sec: number | null;
    creation_trade_delta_sec: number | null;
    rsi5m: number | null;
    rsi_std5m: number | null;
    total_sol_first_5m: number | null;
    first_v_sol: number | null;
  };
  const rows = (res as unknown as { rows: Raw[] }).rows;
  const mapped = rows.map((r) => {
    const firstVSol = r.first_v_sol;
    const pumpMultiple =
      r.current_v_sol != null && firstVSol != null && firstVSol > 0
        ? r.current_v_sol / firstVSol
        : null;
    return {
    mint: r.mint,
    creator: r.creator,
    ageSeconds: r.age_seconds,
    trades5m: r.trades_5m,
    buys5m: r.buys_5m,
    sells5m: r.sells_5m,
    buyVol5m: r.buy_vol_5m,
    sellVol5m: r.sell_vol_5m,
    uniqueBuyers5m: r.unique_buyers_5m,
    currentVSol: r.current_v_sol,
    vSol5mAgo: r.v_sol_5m_ago,
    peakVSol: r.peak_v_sol,
    top3BuyerShare: r.top3_share,
    devSellVolSol: r.dev_sell_vol_sol,
    totalBuyVolSol: r.total_buy_vol_sol,
    bundleWalletCount: r.bundle_wallet_count,
    sniperWalletCount: r.sniper_wallet_count,
    bumpWalletCount: r.bump_wallet_count,
    earlyUniqueBuyers: r.early_unique_buyers,
    hasBundle: r.has_bundle,
    hasSniper: r.has_sniper,
    hasBumpBot: r.has_bump_bot,
    mechanicalUptrend: r.mechanical_uptrend,
    creatorLaunches: r.creator_launches,
    creatorGraduations: r.creator_graduations,
    creatorRugs: r.creator_rugs,
    creatorSpam: r.creator_spam,
    creatorMedianTimeToDumpSec: r.creator_median_time_to_dump_sec,
    creationTradeDeltaSec: r.creation_trade_delta_sec,
    rsi5m: r.rsi5m,
    rsiStd5m: r.rsi_std5m,
    totalSolFirst5m: r.total_sol_first_5m,
    firstVSol,
    pumpMultiple,
  };
  });

  const seen = new Set(mapped.map((r) => r.mint));
  const trendOnly = await fetchTrendOnlyFeatures(seen);
  return [...mapped, ...trendOnly];
}

async function fetchTrendOnlyFeatures(exclude: Set<string>): Promise<MintFeatureRow[]> {
  const res = await getDb().execute(sql`
    SELECT
      tc.mint::text AS mint,
      t.creator::text AS creator,
      EXTRACT(EPOCH FROM (now() - COALESCE(t.created_at, now())))::float8 AS age_seconds,
      tc.v_sol::float8 AS current_v_sol,
      tc.prev_v_sol::float8 AS v_sol_5m_ago,
      tc.v_sol::float8 AS peak_v_sol,
      COALESCE(mbf.bundle_wallet_count, 0)::int AS bundle_wallet_count,
      COALESCE(mbf.sniper_wallet_count, 0)::int AS sniper_wallet_count,
      COALESCE(mbf.bump_wallet_count, 0)::int AS bump_wallet_count,
      COALESCE(mbf.early_unique_buyers, 0)::int AS early_unique_buyers,
      COALESCE(mbf.has_bundle, false) AS has_bundle,
      COALESCE(mbf.has_sniper, false) AS has_sniper,
      COALESCE(mbf.has_bump_bot, false) AS has_bump_bot,
      COALESCE(mbf.mechanical_uptrend, false) AS mechanical_uptrend,
      COALESCE(cf.launches, 0)::int AS creator_launches,
      COALESCE(cf.graduations, 0)::int AS creator_graduations,
      COALESCE(cf.rugs, 0)::int AS creator_rugs,
      cf.spam_score::float8 AS creator_spam,
      cf.median_time_to_dump_sec::float8 AS creator_median_time_to_dump_sec
    FROM trend_candidates tc
    LEFT JOIN tokens t ON t.mint = tc.mint
    LEFT JOIN mint_bot_flags mbf ON mbf.mint = tc.mint
    LEFT JOIN creator_features cf ON cf.creator = t.creator
    WHERE tc.updated_at > now() - interval '30 minutes'
      AND (tc.last_trade_at IS NULL OR tc.last_trade_at > now() - interval '30 minutes')
  `);
  type TrendRaw = {
    mint: string;
    creator: string | null;
    age_seconds: number | null;
    current_v_sol: number | null;
    v_sol_5m_ago: number | null;
    peak_v_sol: number | null;
    bundle_wallet_count: number;
    sniper_wallet_count: number;
    bump_wallet_count: number;
    early_unique_buyers: number;
    has_bundle: boolean;
    has_sniper: boolean;
    has_bump_bot: boolean;
    mechanical_uptrend: boolean;
    creator_launches: number;
    creator_graduations: number;
    creator_rugs: number;
    creator_spam: number | null;
    creator_median_time_to_dump_sec: number | null;
  };
  return (res as unknown as { rows: TrendRaw[] }).rows
    .filter((r) => !exclude.has(r.mint))
    .map((r) => {
      const firstVSol = r.v_sol_5m_ago ?? r.current_v_sol;
      const pumpMultiple =
        r.current_v_sol != null && firstVSol != null && firstVSol > 0
          ? r.current_v_sol / firstVSol
          : null;
      return {
        mint: r.mint,
        creator: r.creator,
        ageSeconds: r.age_seconds,
        trades5m: 0,
        buys5m: 0,
        sells5m: 0,
        buyVol5m: 0,
        sellVol5m: 0,
        uniqueBuyers5m: 0,
        currentVSol: r.current_v_sol,
        vSol5mAgo: r.v_sol_5m_ago,
        peakVSol: r.peak_v_sol,
        top3BuyerShare: null,
        devSellVolSol: 0,
        totalBuyVolSol: 0,
        bundleWalletCount: r.bundle_wallet_count,
        sniperWalletCount: r.sniper_wallet_count,
        bumpWalletCount: r.bump_wallet_count,
        earlyUniqueBuyers: r.early_unique_buyers,
        hasBundle: r.has_bundle,
        hasSniper: r.has_sniper,
        hasBumpBot: r.has_bump_bot,
        mechanicalUptrend: r.mechanical_uptrend,
        creatorLaunches: r.creator_launches,
        creatorGraduations: r.creator_graduations,
        creatorRugs: r.creator_rugs,
        creatorSpam: r.creator_spam,
        creatorMedianTimeToDumpSec: r.creator_median_time_to_dump_sec,
        creationTradeDeltaSec: null,
        rsi5m: null,
        rsiStd5m: null,
        totalSolFirst5m: null,
        firstVSol,
        pumpMultiple,
      };
    });
}

export async function persistFeatureSnapshot(
  rows: Array<{
    mint: string;
    features: MintFeatureRow;
    gradScore: number;
    rugScore: number;
    insiderScore?: number;
    creatorRiskScore?: number;
    washScore?: number;
    confluenceScore?: number;
  }>,
) {
  if (rows.length === 0) return 0;
  const payload = rows.map((r) => ({
    mint: r.mint,
    vSol: r.features.currentVSol ?? null,
    curveProgress:
      r.features.currentVSol != null ? r.features.currentVSol / 85 : null,
    curveVelocity5m:
      r.features.currentVSol != null && r.features.vSol5mAgo != null
        ? r.features.currentVSol - r.features.vSol5mAgo
        : null,
    buyVol5m: r.features.buyVol5m,
    sellVol5m: r.features.sellVol5m,
    buys5m: r.features.buys5m,
    sells5m: r.features.sells5m,
    uniqueBuyers5m: r.features.uniqueBuyers5m,
    gradScore: r.gradScore,
    rugScore: r.rugScore,
    creatorScore: r.creatorRiskScore ?? null,
    washScore: r.washScore ?? null,
    confluenceScore: r.confluenceScore ?? null,
    extras: {
      top3BuyerShare: r.features.top3BuyerShare,
      devSellVolSol: r.features.devSellVolSol,
      ageSeconds: r.features.ageSeconds,
      insiderScore: r.insiderScore,
      bundleWallets: r.features.bundleWalletCount,
      sniperWallets: r.features.sniperWalletCount,
      bumpWallets: r.features.bumpWalletCount,
      creationTradeDeltaSec: r.features.creationTradeDeltaSec,
      totalSolFirst5m: r.features.totalSolFirst5m,
      rsi5m: r.features.rsi5m,
      rsiStd5m: r.features.rsiStd5m,
      firstVSol: r.features.firstVSol,
      pumpMultiple: r.features.pumpMultiple,
    },
  }));
  try {
    await getDb().insert(tokenFeatures).values(payload);
    return payload.length;
  } catch (e) {
    log.warn("feature insert failed", { err: String(e) });
    return 0;
  }
}

/** Latest M1–M5 module scores from token_features (dex-graduated / off-analytics mints). */
export async function fetchLatestModuleScoresBatch(
  mints: string[],
): Promise<Map<string, TokenFeatureModuleScores>> {
  const unique = [...new Set(mints.filter(Boolean))];
  const out = new Map<string, TokenFeatureModuleScores>();
  if (!unique.length) return out;

  const mintList = sql.join(unique.map((m) => sql`${m}`), sql`, `);
  const res = await getDb().execute(sql`
    SELECT DISTINCT ON (f.mint)
      f.mint::text AS mint,
      COALESCE(f.grad_score, 0)::float8 AS grad_score,
      COALESCE(f.rug_score, 0)::float8 AS rug_score,
      COALESCE(f.wash_score, 0)::float8 AS wash_score,
      COALESCE(f.creator_score, 0)::float8 AS creator_score,
      COALESCE((f.extras ->> 'insiderScore')::float8, 0)::float8 AS insider_score,
      f.v_sol::float8 AS v_sol
    FROM token_features f
    WHERE f.mint IN (${mintList})
    ORDER BY f.mint, f.ts DESC
  `);
  for (const row of (
    res as unknown as {
      rows: Array<{
        mint: string;
        grad_score: number;
        rug_score: number;
        wash_score: number;
        creator_score: number;
        insider_score: number;
        v_sol: number | null;
      }>;
    }
  ).rows) {
    out.set(row.mint, {
      gradScore: row.grad_score,
      insiderScore: row.insider_score,
      rugScore: row.rug_score,
      creatorScore: row.creator_score,
      washScore: row.wash_score,
      vSol: row.v_sol,
    });
  }
  return out;
}
