import "server-only";
import { sql } from "drizzle-orm";
import { bootDb, getDb } from "@/lib/db/client";
import { computeActiveFeatures, type MintFeatureRow } from "@/lib/db/repos/features";
import { getAnalyticsSnapshot, type ScoredMint } from "@/lib/workers/analytics";
import { scoreGraduation, scoreGraduationContinuation } from "@/lib/modules/m1-graduation";
import { scoreRug } from "@/lib/modules/m3-rug";
import { scoreInsider } from "@/lib/modules/m2-insider";
import { scoreCreator } from "@/lib/modules/m4-creator";
import { scoreWash } from "@/lib/modules/m5-wash";
import { env, isProfitSignalMode } from "@/lib/env";
import { classifyMiss } from "@/lib/continuation/miss-classifier";
import type { EngineBAction, EvalExpectation, MissType } from "@/lib/continuation/types";

export type EngineAOutcome = {
  engine: "A";
  action: string;
  coverage: "full" | "partial" | "none";
  inActiveUniverse: boolean;
  hasLocalEvents: boolean;
  eventCount24h: number;
  firstDetectionTs: number | null;
  confluenceScore: number | null;
  reason: string;
  vetoes: string[];
  missType: MissType;
};

const CONFLUENCE_STRONG = 0.56;
const CONFLUENCE_MODERATE = 0.48;
const CONFLUENCE_STRONG_PROFIT = 0.52;
const CONFLUENCE_MODERATE_PROFIT = 0.44;

function scoreFeatureRow(f: MintFeatureRow): ScoredMint {
  const profitMode = isProfitSignalMode();
  const gradInput = {
    currentVSol: f.currentVSol,
    vSol5mAgo: f.vSol5mAgo,
    curveVelocity5m:
      f.currentVSol != null && f.vSol5mAgo != null ? f.currentVSol - f.vSol5mAgo : null,
    uniqueBuyers5m: f.uniqueBuyers5m,
    buys5m: f.buys5m,
    sells5m: f.sells5m,
    buyVol5m: f.buyVol5m,
    sellVol5m: f.sellVol5m,
    ageSeconds: f.ageSeconds,
  };
  const useContinuation =
    profitMode &&
    (f.ageSeconds ?? 0) > 600 &&
    (f.buys5m > f.sells5m || (gradInput.curveVelocity5m ?? 0) > 0.3);
  const g = useContinuation ? scoreGraduationContinuation(gradInput) : scoreGraduation(gradInput);
  const r = scoreRug({
    currentVSol: f.currentVSol,
    peakVSol: f.peakVSol,
    buys5m: f.buys5m,
    sells5m: f.sells5m,
    buyVol5m: f.buyVol5m,
    sellVol5m: f.sellVol5m,
    top3BuyerShare: f.top3BuyerShare,
    devSellVolSol: f.devSellVolSol,
    totalBuyVolSol: f.totalBuyVolSol,
    ageSeconds: f.ageSeconds,
    creationTradeDeltaSec: f.creationTradeDeltaSec,
    rsi5m: f.rsi5m,
    rsiStd5m: f.rsiStd5m,
    totalSolFirst5m: f.totalSolFirst5m,
  });
  const ins = scoreInsider({
    top3BuyerShare: f.top3BuyerShare,
    uniqueBuyers5m: f.uniqueBuyers5m,
    bundleWalletCount: f.bundleWalletCount,
    sniperWalletCount: f.sniperWalletCount,
    earlyUniqueBuyers: f.earlyUniqueBuyers,
    ageSeconds: f.ageSeconds,
  });
  const cr = scoreCreator({
    launches: f.creatorLaunches,
    graduations: f.creatorGraduations,
    rugs: f.creatorRugs,
    spamScore: f.creatorSpam,
    medianTimeToDumpSec: f.creatorMedianTimeToDumpSec,
  });
  const w = scoreWash({
    bumpWalletCount: f.bumpWalletCount,
    buys5m: f.buys5m,
    sells5m: f.sells5m,
    buyVol5m: f.buyVol5m,
    sellVol5m: f.sellVol5m,
    uniqueBuyers5m: f.uniqueBuyers5m,
    trades5m: f.trades5m,
  });
  const hardVeto = f.hasBundle || f.mechanicalUptrend;
  let confluenceScore = hardVeto
    ? 0
    : Math.max(
        0,
        Math.min(
          1,
          g.score -
            (profitMode ? 0.35 : 0.4) * r.score -
            (profitMode ? 0.22 : 0.25) * ins.score -
            (profitMode ? 0.18 : 0.2) * cr.score -
            (profitMode ? 0.18 : 0.2) * w.score,
        ),
      );
  if (profitMode && !hardVeto && g.score >= 0.58) {
    confluenceScore = Math.max(confluenceScore, 0.48);
  }
  return {
    mint: f.mint,
    gradScore: g.score,
    rugScore: r.score,
    insiderScore: ins.score,
    creatorRiskScore: cr.score,
    washScore: w.score,
    confluenceScore,
    gradReasons: g.reasons,
    rugReasons: r.reasons,
    insiderReasons: ins.reasons,
    creatorReasons: cr.reasons,
    washReasons: w.reasons,
    features: f,
  };
}

function decideEngineA(scored: ScoredMint): { action: string; reason: string; vetoes: string[] } {
  const profit = isProfitSignalMode();
  const confStrong = profit ? CONFLUENCE_STRONG_PROFIT : CONFLUENCE_STRONG;
  const confModerate = profit ? CONFLUENCE_MODERATE_PROFIT : CONFLUENCE_MODERATE;
  const vetoes: string[] = [];
  let action: string | null = null;
  let reason = "";

  if (scored.confluenceScore >= confStrong) {
    action = "BUY_STRONG";
    reason = `confluence=${scored.confluenceScore.toFixed(2)}`;
  } else if (scored.confluenceScore >= confModerate) {
    action = "BUY_MODERATE";
    reason = `confluence=${scored.confluenceScore.toFixed(2)}`;
  } else if (scored.confluenceScore >= 0.35) {
    action = "WATCH";
    reason = `watch_band conf=${scored.confluenceScore.toFixed(2)}`;
  }

  const pumpMult = scored.features.pumpMultiple;
  const avoidPump = profit ? 4.0 : 2.5;
  if (pumpMult != null && pumpMult >= avoidPump && action) {
    vetoes.push(`pump_trap:${pumpMult.toFixed(2)}`);
    action = "AVOID";
    reason = `pump_trap ${pumpMult.toFixed(1)}x`;
  }

  return { action: action ?? "NONE", reason: reason || "below_threshold", vetoes };
}

async function countEvents24h(mint: string): Promise<number> {
  await bootDb();
  const res = await getDb().execute(sql`
    SELECT COUNT(*)::int AS n FROM events
    WHERE mint = ${mint} AND ts > now() - interval '24 hours'
  `);
  return (res as unknown as { rows: Array<{ n: number }> }).rows[0]?.n ?? 0;
}

async function fetchFirstEngineADetectionTs(mint: string): Promise<number | null> {
  await bootDb();
  try {
    const res = await getDb().execute(sql`
      SELECT (EXTRACT(EPOCH FROM MIN(ts)) * 1000)::float8 AS ts_ms
      FROM decision_log
      WHERE mint = ${mint}
        AND ts > now() - interval '24 hours'
        AND (reason_human IS NULL OR reason_human NOT LIKE 'engine=B%')
        AND action IN ('WATCH', 'BUY_MODERATE', 'BUY_STRONG')
    `);
    const v = (res as unknown as { rows: Array<{ ts_ms: number | null }> }).rows[0]?.ts_ms;
    return v != null && Number.isFinite(v) ? Math.round(v) : null;
  } catch {
    return null;
  }
}

async function resolveScoredMint(mint: string): Promise<ScoredMint | null> {
  const snap = getAnalyticsSnapshot();
  const fromWorker = snap?.scored.find((s) => s.mint === mint);
  if (fromWorker) return fromWorker;

  const rows = await computeActiveFeatures();
  const row = rows.find((r) => r.mint === mint);
  if (!row) return null;
  return scoreFeatureRow(row);
}

/**
 * Engine A baseline: curve-native scoring + historical decision_log first detection.
 */
export async function evaluateEngineABaseline(
  mint: string,
  expected: EvalExpectation = "ALERT",
): Promise<EngineAOutcome> {
  const eventCount = await countEvents24h(mint);
  const hasLocalEvents = eventCount > 0;
  const firstDetectionTs = await fetchFirstEngineADetectionTs(mint);

  const scored = await resolveScoredMint(mint);
  let action = "NONE";
  let coverage: EngineAOutcome["coverage"] = "none";
  let inActiveUniverse = false;
  let confluenceScore: number | null = null;
  let reason = "not_in_engine_a_active_set";
  const vetoes: string[] = [];

  if (scored) {
    inActiveUniverse = true;
    coverage = hasLocalEvents ? "full" : "partial";
    confluenceScore = scored.confluenceScore;
    const decided = decideEngineA(scored);
    action = decided.action;
    reason = decided.reason;
    vetoes.push(...decided.vetoes);
  } else if (hasLocalEvents) {
    coverage = "partial";
    reason = "events_exist_not_in_active_scoring_window";
  }

  const actualBStyle: EngineBAction =
    action === "NONE" || action === "AVOID"
      ? "NONE"
      : action === "WATCH"
        ? "WATCH"
        : "ALERT";

  const missType = classifyMiss({
    mint,
    expected,
    actual: actualBStyle,
    inUniverse: inActiveUniverse,
    normalized: inActiveUniverse,
    traces: [],
    opsHealthy: true,
  });

  return {
    engine: "A",
    action,
    coverage,
    inActiveUniverse,
    hasLocalEvents,
    eventCount24h: eventCount,
    firstDetectionTs,
    confluenceScore,
    reason,
    vetoes,
    missType: inActiveUniverse ? missType : "NOT_IN_UNIVERSE",
  };
}
