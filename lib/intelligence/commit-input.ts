import "server-only";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { fetchDexMarketBatchCached } from "@/lib/dex/snapshot-cache";
import { intelEnv } from "@/lib/env";
import { getHotMintScores } from "@/lib/intelligence/hot-mints";
import type { DexMarketSnapshot } from "@/lib/dex/market-snapshot";
import { normalizeDexSnapshot } from "@/lib/dex/normalizer";
import { fetchRecentContinuationMints } from "@/lib/db/repos/continuation-candidates";
import { getAnalyticsSnapshot } from "@/lib/workers/analytics";
import { isHybridSignalMode, isProfitSignalMode } from "@/lib/env";
import { getPriorRank, getPriorState } from "@/lib/continuation/state-registry";
import type { RankInput } from "@/lib/continuation/cross-mint-rank";
import {
  rankInputFromScoredMint,
  scoredMintToIntelligenceInput,
  riskFlagsFromScored,
} from "@/lib/intelligence/scored-mint-adapter";
import type {
  CrossMintRanks,
  IntelligenceInputSnapshot,
  IntelligenceRiskFlags,
  TriggerEvent,
} from "@/lib/intelligence/types";
import type { EngineBResult, MomentumState } from "@/lib/continuation/types";
import { aggregateDeltaEvents } from "@/lib/intelligence/state-delta-detector";
import { buildCrossMintRanks } from "@/lib/intelligence/dual-engine";
import { rankInputFromResult } from "@/lib/continuation/cross-mint-rank";
import { engineB } from "@/lib/continuation/engine-b";
export type MintCommitRow = {
  input: IntelligenceInputSnapshot;
  risk_flags: IntelligenceRiskFlags;
  prior_state: MomentumState;
  prior_rank: number | null;
  rank_input: RankInput;
  normalized_dex?: ReturnType<typeof normalizeDexSnapshot>;
};

export type CommitInputBundle = {
  loadedAt: number;
  mints: string[];
  rows: Map<string, MintCommitRow>;
  priorRanks: Map<string, number>;
};

function dexToInput(mint: string, raw: DexMarketSnapshot): IntelligenceInputSnapshot {
  const ageSec = raw.pairCreatedAt
    ? Math.max(0, (Date.now() - raw.pairCreatedAt.getTime()) / 1000)
    : 3600;
  return {
    mint,
    age_seconds: ageSec,
    liquidity_usd: raw.liqUsd,
    volume_m5: raw.volM5,
    volume_m30: raw.volH1 / 2,
    volume_h1: raw.volH1,
    price_change_m1: (raw.priceChangeM5 ?? 0) / 5,
    price_change_m5: raw.priceChangeM5 ?? 0,
    price_change_h1: raw.priceChangeH1 ?? 0,
    buy_sell_ratio: raw.buySellRatio,
    unique_wallets_5m: 0,
    unique_wallets_30m: 0,
    holder_growth: 0,
    pool_count: raw.poolCount,
    dex_rank: null,
    is_new_pool: ageSec < 600,
    migration_status: "dex",
  };
}

export async function loadCommitInputBundle(): Promise<CommitInputBundle> {
  const mintSet = new Set<string>();
  const rows = new Map<string, MintCommitRow>();
  const priorRanks = new Map<string, number>();
  const maxUniverse = intelEnv().universeMax;

  if (isProfitSignalMode()) {
    const dexCap = isHybridSignalMode()
      ? Math.max(30, Math.floor(maxUniverse * 0.45))
      : maxUniverse;
    const dexMints = (await fetchRecentContinuationMints(45)).slice(0, dexCap);
    for (const m of dexMints) mintSet.add(m);
    const markets = await fetchDexMarketBatchCached([...mintSet]);
    const hints = await loadContinuationCandidateHints([...mintSet]);
    for (const mint of mintSet) {
      const raw = markets.get(mint);
      if (!raw) continue;
      const normalized = normalizeDexSnapshot(raw);
      const input = dexToInput(mint, raw);
      const prior = getPriorRank(mint);
      if (prior != null) priorRanks.set(mint, prior);
      const hint = hints.get(mint);
      const priorState = (hint?.state as MomentumState | undefined) ?? getPriorState(mint);
      const cached = hint?.engineBResult;
      const rank_input = cached
        ? rankInputFromResult(mint, normalized, cached)
        : rankInputFromResult(
            mint,
            normalized,
            engineB(mint, normalized, {
              rankPercentile: prior ?? hint?.rank ?? 0.5,
              rankVelocity: 0,
              eventImpulse: 0,
              leadingScore: 0,
              universeSize: mintSet.size,
              priorState,
              persistTrace: false,
            }).result,
          );
      rows.set(mint, {
        input,
        risk_flags: {},
        prior_state: priorState,
        prior_rank: prior ?? hint?.rank ?? null,
        rank_input,
        normalized_dex: normalized,
      });
    }
  }

  for (const h of getHotMintScores()) {
    mintSet.add(h.mint);
  }

  const snap = getAnalyticsSnapshot();
  if (snap) {
    for (const s of snap.scored) {
      mintSet.add(s.mint);
      if (rows.has(s.mint)) continue;
      const input = scoredMintToIntelligenceInput(s);
      const prior = getPriorRank(s.mint);
      if (prior != null) priorRanks.set(s.mint, prior);
      rows.set(s.mint, {
        input,
        risk_flags: riskFlagsFromScored(s),
        prior_state: getPriorState(s.mint) as MomentumState,
        prior_rank: prior,
        rank_input: rankInputFromScoredMint(s),
      });
    }
  }

  const mints = [...mintSet].slice(0, maxUniverse);
  const trimmedRows = new Map<string, MintCommitRow>();
  for (const m of mints) {
    const row = rows.get(m);
    if (row) trimmedRows.set(m, row);
  }

  return {
    loadedAt: Date.now(),
    mints,
    rows: trimmedRows,
    priorRanks,
  };
}

export type PreparedMintEval = {
  input: IntelligenceInputSnapshot;
  cross_mint: CrossMintRanks;
  trigger_events: TriggerEvent[];
  event_impulse: number;
  prior_state: MomentumState;
  risk_flags: IntelligenceRiskFlags;
};

/** Delta aggregation + rank refresh for one commit tick. */
export async function prepareMintEval(
  bundle: CommitInputBundle,
  mint: string,
): Promise<PreparedMintEval | null> {
  const row = bundle.rows.get(mint);
  if (!row) return null;

  const crossTable = buildCrossMintRanks(
    [...bundle.rows.values()].map((r) => r.rank_input),
    bundle.priorRanks,
    0.17,
  );
  const cross = crossTable.get(mint) ?? {
    rank_percentile: 0.5,
    velocity_rank: 0.5,
    liquidity_rank: 0.5,
  };

  const { trigger_events, event_impulse } = await aggregateDeltaEvents(mint, row.input, {
    cross_rank: cross.rank_percentile,
    prior_rank: row.prior_rank ?? undefined,
  });

  return {
    input: row.input,
    cross_mint: cross,
    trigger_events,
    event_impulse,
    prior_state: row.prior_state,
    risk_flags: row.risk_flags,
  };
}

export type ContinuationCandidateHint = {
  state: string;
  rank: number;
  engineBResult: EngineBResult | null;
};

export async function loadContinuationCandidateHints(
  mints: string[],
): Promise<Map<string, ContinuationCandidateHint>> {
  const out = new Map<string, ContinuationCandidateHint>();
  if (!mints.length) return out;
  try {
    const res = await getDb().execute(sql`
      SELECT mint, momentum_state, rank_percentile, engine_b_json
      FROM continuation_candidates
      WHERE updated_at > now() - interval '45 minutes'
        AND mint = ANY(${sql.raw(
          `ARRAY[${mints.map((m) => `'${m.replace(/'/g, "''")}'`).join(",")}]::text[]`,
        )})
    `);
    for (const row of (
      res as unknown as {
        rows: Array<{
          mint: string;
          momentum_state: string;
          rank_percentile: number;
          engine_b_json: EngineBResult | null;
        }>;
      }
    ).rows) {
      let engineBResult: EngineBResult | null = null;
      if (row.engine_b_json && typeof row.engine_b_json === "object") {
        engineBResult = row.engine_b_json as EngineBResult;
      }
      out.set(row.mint, {
        state: row.momentum_state ?? "cold",
        rank: row.rank_percentile ?? 0.5,
        engineBResult,
      });
    }
  } catch {
    /* optional */
  }
  return out;
}

/** @deprecated use loadContinuationCandidateHints */
export async function loadCandidateMomentumStates(
  mints: string[],
): Promise<Map<string, { state: string; rank: number }>> {
  const hints = await loadContinuationCandidateHints(mints);
  const out = new Map<string, { state: string; rank: number }>();
  for (const [mint, h] of hints) out.set(mint, { state: h.state, rank: h.rank });
  return out;
}
