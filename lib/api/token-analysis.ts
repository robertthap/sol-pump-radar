import "server-only";
import { getEffectiveSignalMode } from "@/lib/env";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { fetchPumpFunCoin } from "@/lib/pump/fun-api";
import { fetchRugLabel } from "@/lib/db/repos/rug-labels";
import { fetchMintFlags } from "@/lib/db/repos/bots";
import { analyzeMintInsiders } from "@/lib/intel/insider-tracker";
import { classifyTradeable } from "@/lib/trade/tradeable";
import { cached } from "@/lib/api/short-cache";
import { scoreSignal } from "@/lib/signals/quality";

export type TokenAnalysis = {
  mint: string;
  pump: Awaited<ReturnType<typeof fetchPumpFunCoin>>;
  symbol: string | null;
  name: string | null;
  vSol: number | null;
  usdMarketCap: number | null;
  complete: boolean;
  imageUri: string | null;
  scores: {
    grad: number | null;
    rug: number | null;
    confluence: number | null;
    momentum: number | null;
    creator: number | null;
    wash: number | null;
  };
  signal: {
    action: string;
    confluence: number | null;
    reason: string | null;
    ts: string | null;
    qualityScore: number | null;
    qualityTier: string | null;
    tradable: boolean;
  } | null;
  rug: { label: string; reason: string | null } | null;
  flags: { bundle: boolean; sniper: boolean; mechanical: boolean } | null;
  tradeable: string;
  tradeableReason: string;
  tradeCount: number;
  ageSeconds: number;
  insider: {
    smartMoneyCount: number;
    avgTStat: number | null;
    label: string;
    topWallets: Array<{ wallet: string; tStat: number; avgReturn: number }>;
  } | null;
};

export async function fetchTokenAnalysis(
  mint: string,
  opts?: { skipPump?: boolean; skipInsider?: boolean },
): Promise<TokenAnalysis> {
  return cached(
    `analysis:${mint}:${opts?.skipPump ? "lite" : "full"}:${opts?.skipInsider ? "noin" : "in"}`,
    5_000,
    async () => {
    const db = getDb();
    const [rug, flags, insider] = await Promise.all([
      fetchRugLabel(mint).catch(() => null),
      fetchMintFlags(mint).catch(() => null),
      opts?.skipInsider
        ? Promise.resolve(null)
        : analyzeMintInsiders(mint).catch(() => null),
    ]);

    const snapRes = await db.execute(sql`
      WITH latest_feat AS (
        SELECT v_sol, grad_score, rug_score, confluence_score, momentum_score,
               creator_score, wash_score, ts AS feat_ts
        FROM token_features
        WHERE mint = ${mint}
        ORDER BY ts DESC LIMIT 1
      ),
      last_ev AS (
        SELECT v_sol_after::float8 AS v
        FROM events WHERE mint = ${mint} AND v_sol_after IS NOT NULL
        ORDER BY ts DESC LIMIT 1
      ),
      latest_dec AS (
        SELECT action::text AS action, confluence_score::float8 AS conf,
               reason_human::text AS reason, ts AS dec_ts,
               module_scores
        FROM decision_log WHERE mint = ${mint}
        ORDER BY ts DESC LIMIT 1
      ),
      flow AS (
        SELECT
          COUNT(*) FILTER (WHERE kind IN ('buy','sell'))::int AS trade_count,
          EXTRACT(EPOCH FROM (now() - MAX(ts)))::float8 AS inactivity_sec
        FROM events WHERE mint = ${mint}
      ),
      first_v AS (
        SELECT v_sol_after::float8 AS first_v FROM events
        WHERE mint = ${mint} AND v_sol_after IS NOT NULL AND v_sol_after > 0
        ORDER BY ts ASC LIMIT 1
      ),
      token_row AS (
        SELECT symbol::text AS symbol, name::text AS name, created_at
        FROM tokens WHERE mint = ${mint} LIMIT 1
      )
      SELECT
        COALESCE(lf.v_sol, le.v)::float8 AS v_sol,
        lf.grad_score, lf.rug_score, lf.confluence_score, lf.momentum_score,
        lf.creator_score, lf.wash_score,
        ld.action, ld.conf, ld.reason, ld.dec_ts,
        (ld.module_scores->>'M2_INSIDER')::float8 AS insider_mod,
        (ld.module_scores->>'M5_WASH')::float8 AS wash_mod,
        COALESCE(fl.trade_count, 0)::int AS trade_count,
        fl.inactivity_sec,
        fv.first_v,
        tr.symbol, tr.name, tr.created_at,
        EXTRACT(EPOCH FROM (now() - COALESCE(tr.created_at, now())))::float8 AS age_seconds
      FROM (SELECT 1) x
      LEFT JOIN latest_feat lf ON true
      LEFT JOIN last_ev le ON true
      LEFT JOIN latest_dec ld ON true
      LEFT JOIN flow fl ON true
      LEFT JOIN first_v fv ON true
      LEFT JOIN token_row tr ON true
    `);

    type Row = {
      v_sol: number | null;
      grad_score: number | null;
      rug_score: number | null;
      confluence_score: number | null;
      momentum_score: number | null;
      creator_score: number | null;
      wash_score: number | null;
      action: string | null;
      conf: number | null;
      reason: string | null;
      dec_ts: Date | string | null;
      insider_mod: number | null;
      wash_mod: number | null;
      trade_count: number;
      inactivity_sec: number | null;
      first_v: number | null;
      symbol: string | null;
      name: string | null;
      age_seconds: number | null;
    };

    const row = (snapRes as unknown as { rows: Row[] }).rows[0] ?? ({} as Row);

    const needPump =
      !opts?.skipPump &&
      (row.v_sol == null || !row.symbol || row.symbol.trim() === "");
    const pump = needPump ? await fetchPumpFunCoin(mint).catch(() => null) : null;

    const ageSeconds = row.age_seconds ?? 0;
    const peak = row.v_sol;
    const firstV = row.first_v;
    const pumpMultiple =
      peak != null && firstV != null && firstV > 0 ? peak / firstV : null;

    const tradeable = classifyTradeable({
      rugLabel: rug?.label ?? null,
      ageSeconds,
      action: row.action,
      hasBundle: flags?.hasBundle ?? false,
      mechanicalUptrend: flags?.mechanicalUptrend ?? false,
      hasSniper: flags?.hasSniper ?? false,
      tradeCount: row.trade_count ?? 0,
      confluence: row.confluence_score ?? row.conf,
      inactivitySeconds: row.inactivity_sec,
      pumpMultiple,
      insiderSignal: insider?.hasInsiderEntry ?? false,
    });

    const quality =
      row.action != null
        ? scoreSignal({
      signalMode: getEffectiveSignalMode(),
            action: row.action,
            confluenceScore: row.conf ?? row.confluence_score ?? 0,
            gradScore: row.grad_score,
            rugScore: row.rug_score,
            insiderScore: row.insider_mod,
            washScore: row.wash_mod ?? row.wash_score,
            creatorScore: row.creator_score,
            smartMoneyCount: insider?.smartMoneyCount ?? 0,
            rugLabel: rug?.label ?? null,
          })
        : null;

    return {
      mint,
      pump,
      symbol: pump?.symbol ?? row.symbol,
      name: pump?.name ?? row.name,
      vSol: row.v_sol ?? pump?.vSol ?? null,
      usdMarketCap: pump?.usdMarketCap ?? null,
      complete: pump?.complete ?? false,
      imageUri: pump?.imageUri ?? null,
      scores: {
        grad: row.grad_score,
        rug: row.rug_score,
        confluence: row.confluence_score,
        momentum: row.momentum_score,
        creator: row.creator_score,
        wash: row.wash_score,
      },
      signal: row.action
        ? {
            action: row.action,
            confluence: row.conf,
            reason: row.reason,
            ts: row.dec_ts instanceof Date ? row.dec_ts.toISOString() : row.dec_ts,
            qualityScore: quality?.score ?? null,
            qualityTier: quality?.tier ?? null,
            tradable: quality?.tradable ?? false,
          }
        : null,
      rug: rug ? { label: rug.label, reason: rug.reason } : null,
      flags: flags
        ? {
            bundle: flags.hasBundle,
            sniper: flags.hasSniper,
            mechanical: flags.mechanicalUptrend,
          }
        : null,
      tradeable: tradeable.status,
      tradeableReason: tradeable.reason,
      tradeCount: row.trade_count ?? 0,
      ageSeconds,
      insider: insider
        ? {
            smartMoneyCount: insider.smartMoneyCount,
            avgTStat: insider.avgTStat,
            label: insider.label,
            topWallets: insider.topWallets,
          }
        : null,
    };
  });
}
