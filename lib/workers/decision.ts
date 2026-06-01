import "server-only";
/**
 * RETIRED: decision worker removed from orchestrator (P1.3).
 * Signal generation lives in intelligence-commit; decide() below is legacy reference only.
 */
import { logger } from "@/lib/log";
import { env, isProfitSignalMode } from "@/lib/env";
import { readState } from "@/lib/circuit-breaker/state";
import { getAnalyticsSnapshot, type ScoredMint } from "./analytics";
import { readActiveOverrides } from "@/lib/db/repos/tuner";
import { fetchActiveAvoidRules } from "@/lib/db/repos/loss-learning";
import { getActiveSession } from "@/lib/db/repos/auto-sessions";
import { fetchManyMintFlags, type MintFlags, fetchManySmartMoneyCounts } from "@/lib/db/repos/bots";
import { fetchManyRingExposures, type MintRingExposure } from "@/lib/db/repos/clusters";
import { fetchRugLabels } from "@/lib/db/repos/rug-labels";
import type { DecisionAction } from "@/lib/shared/types";
import { touchWorker } from "@/lib/workers/heartbeat";

type AvoidRule = { id: bigint; featureKey: string; operator: string; threshold: number };
let cachedRulesAt = 0;
let cachedRules: AvoidRule[] = [];
const RULES_TTL_MS = 60_000;

async function effectiveAvoidRules(): Promise<AvoidRule[]> {
  if (Date.now() - cachedRulesAt > RULES_TTL_MS) {
    try {
      const session = await getActiveSession();
      if (session && !session.params.useLearnedAvoids) {
        cachedRules = [];
      } else {
        cachedRules = await fetchActiveAvoidRules();
      }
      cachedRulesAt = Date.now();
    } catch {
      // keep cache on failure
    }
  }
  return cachedRules;
}

function resolveFeature(
  s: ScoredMint,
  key: string,
  ctx?: { ringExposure?: MintRingExposure | null },
): number | null {
  const f = s.features;
  switch (key) {
    case "feat.unique_buyers_5m":
      return f.uniqueBuyers5m;
    case "feat.top3_buyer_share":
      return f.top3BuyerShare;
    case "feat.dev_sell_vol_sol":
      return f.devSellVolSol;
    case "feat.age_at_entry":
      return f.ageSeconds ?? null;
    case "feat.sells_5m_over_trades_5m": {
      const trades = f.trades5m;
      if (!trades || trades === 0) return null;
      return f.sells5m / trades;
    }
    case "module.M1_GRADUATION":
      return s.gradScore;
    case "module.M3_RUG":
      return s.rugScore;
    case "module.M2_INSIDER":
      return s.insiderScore;
    case "module.M4_CREATOR":
      return s.creatorRiskScore;
    case "module.M5_WASH":
      return s.washScore;
    case "feat.bundle_ring_buyers":
      return ctx?.ringExposure?.bundleRingBuyers ?? null;
    case "feat.sniper_ring_buyers":
      return ctx?.ringExposure?.sniperRingBuyers ?? null;
    // Gate confidences are computed only inside the auto-trader, not here,
    // so these decision-side rules are inert until the auto-trader checks
    // them itself. Returning null disables them.
    case "feat.gate_confidence":
    case "feat.gate_wallet_conf":
    case "feat.gate_coin_conf":
    case "feat.gate_timing_conf":
      return null;
    case "feat.creation_trade_delta":
      return f.creationTradeDeltaSec ?? null;
    case "feat.total_sol_first_5m":
      return f.totalSolFirst5m ?? null;
    case "feat.rsi_5m":
      return f.rsi5m ?? null;
    case "feat.rsi_std_5m":
      return f.rsiStd5m ?? null;
    case "feat.pump_multiple":
      return f.pumpMultiple ?? null;
    default:
      return null;
  }
}

function ruleTriggered(rule: AvoidRule, value: number): boolean {
  switch (rule.operator) {
    case "<":
      return value < rule.threshold;
    case "<=":
      return value <= rule.threshold;
    case ">":
      return value > rule.threshold;
    case ">=":
      return value >= rule.threshold;
    default:
      return false;
  }
}

const log = logger("decision");
const TICK_MS = 10_000;
const COOLDOWN_MS = 60_000;
const COOLDOWN_PROFIT_MS = 30_000;

const CONFLUENCE_STRONG = 0.56;
const CONFLUENCE_MODERATE = 0.48;
const CONFLUENCE_STRONG_PROFIT = 0.52;
const CONFLUENCE_MODERATE_PROFIT = 0.44;

const lastEmitByMint = new Map<string, { action: string; at: number }>();

type Thresholds = {
  gradBuyStrong: number;
  gradBuyModerate: number;
  gradWatch: number;
  rugBuyCap: number;
  rugAvoid: number;
};

function thresholdsFor(preset: string): Thresholds {
  let th: Thresholds;
  switch (preset) {
    case "conservative":
      th = { gradBuyStrong: 0.85, gradBuyModerate: 0.7, gradWatch: 0.5, rugBuyCap: 0.15, rugAvoid: 0.4 };
      break;
    case "aggressive":
      th = { gradBuyStrong: 0.65, gradBuyModerate: 0.5, gradWatch: 0.35, rugBuyCap: 0.35, rugAvoid: 0.6 };
      break;
    default:
      th = { gradBuyStrong: 0.75, gradBuyModerate: 0.6, gradWatch: 0.45, rugBuyCap: 0.25, rugAvoid: 0.5 };
  }
  if (isProfitSignalMode()) {
    return {
      gradBuyStrong: Math.min(th.gradBuyStrong, 0.68),
      gradBuyModerate: Math.min(th.gradBuyModerate, 0.52),
      gradWatch: th.gradWatch,
      rugBuyCap: Math.max(th.rugBuyCap, 0.3),
      rugAvoid: th.rugAvoid,
    };
  }
  return th;
}

function decide(scored: ScoredMint, th: Thresholds): { action: DecisionAction | null; reason: string } {
  const profit = isProfitSignalMode();
  const confStrong = profit ? CONFLUENCE_STRONG_PROFIT : CONFLUENCE_STRONG;
  const confModerate = profit ? CONFLUENCE_MODERATE_PROFIT : CONFLUENCE_MODERATE;
  const creatorWatch = profit ? 0.65 : 0.6;

  if (scored.rugScore >= th.rugAvoid) {
    return {
      action: "AVOID",
      reason: scored.rugReasons.join("; ") || "rug signals elevated",
    };
  }
  if (scored.insiderScore >= 0.58) {
    return {
      action: "AVOID",
      reason: scored.insiderReasons.join("; ") || "insider concentration too high",
    };
  }
  if (scored.washScore >= 0.65) {
    return {
      action: "AVOID",
      reason: scored.washReasons.join("; ") || "wash trading detected",
    };
  }
  if (scored.rugScore <= th.rugBuyCap && scored.gradScore >= th.gradBuyStrong) {
    if (scored.confluenceScore < confStrong) {
      if (scored.gradScore >= th.gradBuyModerate && scored.confluenceScore >= confModerate) {
        return {
          action: "BUY_MODERATE",
          reason: `${scored.gradReasons.join("; ")} | confluence ${scored.confluenceScore.toFixed(2)} below strong threshold`,
        };
      }
      return { action: "WATCH", reason: `grad strong but confluence ${scored.confluenceScore.toFixed(2)} too low` };
    }
    return {
      action: "BUY_STRONG",
      reason: scored.gradReasons.join("; "),
    };
  }
  if (scored.rugScore <= th.rugBuyCap && scored.gradScore >= th.gradBuyModerate) {
    if (scored.confluenceScore < confModerate) {
      return { action: "WATCH", reason: `moderate grad but confluence ${scored.confluenceScore.toFixed(2)} too low` };
    }
    if (scored.creatorRiskScore >= creatorWatch) {
      return { action: "WATCH", reason: `creator risk ${scored.creatorRiskScore.toFixed(2)} blocks buy` };
    }
    return {
      action: "BUY_MODERATE",
      reason: scored.gradReasons.join("; "),
    };
  }
  if (scored.rugScore <= th.rugAvoid && scored.gradScore >= th.gradWatch) {
    return {
      action: "WATCH",
      reason: scored.gradReasons.join("; ") || "moderate momentum",
    };
  }
  return { action: null, reason: "" };
}

function isContinuationCandidate(s: ScoredMint): boolean {
  const f = s.features;
  const age = f.ageSeconds ?? 0;
  if (age <= 600) return false;
  const velocity =
    f.currentVSol != null && f.vSol5mAgo != null ? f.currentVSol - f.vSol5mAgo : 0;
  const flowOk = f.buys5m > f.sells5m && f.uniqueBuyers5m >= 4;
  const trendOk = velocity > 0.3 && (f.currentVSol ?? 0) >= 8;
  return flowOk || trendOk;
}

function decideContinuation(
  scored: ScoredMint,
  th: Thresholds,
): { action: DecisionAction | null; reason: string } {
  if (!isContinuationCandidate(scored)) return { action: null, reason: "" };
  if (scored.rugScore >= th.rugAvoid) return { action: null, reason: "" };
  if (scored.insiderScore >= 0.58 || scored.washScore >= 0.65) {
    return { action: null, reason: "" };
  }
  if (scored.rugScore <= th.rugBuyCap && scored.gradScore >= 0.45 && scored.confluenceScore >= 0.52) {
    return {
      action: "BUY_STRONG",
      reason: `continuation | ${scored.gradReasons.join("; ")}`,
    };
  }
  if (scored.rugScore <= th.rugBuyCap && scored.gradScore >= 0.42 && scored.confluenceScore >= 0.46) {
    return {
      action: "BUY_MODERATE",
      reason: `continuation | ${scored.gradReasons.join("; ")}`,
    };
  }
  return { action: null, reason: "" };
}

let cachedOverridesAt = 0;
let cachedOverrides: Partial<Thresholds> = {};
const OVERRIDES_TTL_MS = 30_000;

async function effectiveThresholds(preset: string, sessionPaperBoost = false): Promise<Thresholds> {
  const base = thresholdsFor(preset);
  if (Date.now() - cachedOverridesAt > OVERRIDES_TTL_MS) {
    try {
      const o = await readActiveOverrides();
      cachedOverrides = {
        gradBuyStrong: o.gradBuyStrong,
        gradBuyModerate: o.gradBuyModerate,
        gradWatch: o.gradWatch,
        rugBuyCap: o.rugBuyCap,
        rugAvoid: o.rugAvoid,
      };
      cachedOverridesAt = Date.now();
    } catch {
      // keep previous cache
    }
  }
  let th: Thresholds = {
    gradBuyStrong: cachedOverrides.gradBuyStrong ?? base.gradBuyStrong,
    gradBuyModerate: cachedOverrides.gradBuyModerate ?? base.gradBuyModerate,
    gradWatch: cachedOverrides.gradWatch ?? base.gradWatch,
    rugBuyCap: cachedOverrides.rugBuyCap ?? base.rugBuyCap,
    rugAvoid: cachedOverrides.rugAvoid ?? base.rugAvoid,
  };
  if (sessionPaperBoost && isProfitSignalMode()) {
    th = {
      ...th,
      gradBuyStrong: Math.max(0.5, th.gradBuyStrong - 0.06),
      gradBuyModerate: Math.max(0.42, th.gradBuyModerate - 0.05),
      rugBuyCap: Math.min(0.38, th.rugBuyCap + 0.04),
    };
  }
  return th;
}

export async function startDecision() {
  log.info("decision feeder starting (emit disabled — intelligence-commit decides)", {
    tickMs: TICK_MS,
  });

  async function tick() {
    const snap = getAnalyticsSnapshot();
    if (!snap) return;
    const cb = await readState();
    if (cb.state === "HALTED") return;
    touchWorker("decision");
  }

  const interval = setInterval(() => {
    tick().catch((e) => log.error("tick rejected", { err: String(e) }));
  }, TICK_MS);

  return () => clearInterval(interval);
}
