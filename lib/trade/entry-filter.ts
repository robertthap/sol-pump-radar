import "server-only";
import type { InsiderAnalysis } from "@/lib/intel/insider-tracker";
import { walletGate, coinGate, timingGate, aggregateGates } from "@/lib/intel/three-gate";
import type { MintFlags } from "@/lib/db/repos/bots";
import { fetchBuyerProfilesForMint } from "@/lib/db/repos/bots";
import { readActiveGateWeights } from "@/lib/db/repos/tuner";
import { imitationPenaltyPct } from "@/lib/intel/imitation";
import { isProfitSignalMode, allowsLaunchTier, isV2SimpleEntry } from "@/lib/env";
import { launchQualityScore } from "@/lib/intelligence/launch-rank";
import { relaxedTierEnabled } from "@/lib/trade/tier-control";
import { variantEnters, ABLATION_THRESHOLDS, type AblationFeatures } from "@/lib/intelligence/ablation-router";

/**
 * The validated V2 entry rule (T4 ablation, SYSTEM_DESIGN §IV.8): enter purely on
 * a core-intelligence floor + a hard rug veto. No confluence/three-gate/grad floor —
 * those are the gates the ablation found actively harmful. Hard safety vetoes
 * ('rugged' label, bundle/mechanical) are applied upstream in the auto-trader and
 * still hold. The decision DELEGATES to the pure, tested `variantEnters("V2", …)`
 * so the live gate is identical-by-construction to what the ablation measured.
 */
function qualifyV2Entry(ctx: EntryContext): EntryFilterResult {
  const ms = ctx.moduleScores ?? {};
  const intel = ms._intelligence ?? 0;
  const rug = ms.M3_RUG ?? 0;
  const feat: AblationFeatures = {
    intelligence: intel, rug, insider: 0, wash: 0, creator: 0, grad: 0, engineA: 0, autoAllowed: 0,
  };
  if (!variantEnters("V2", feat, ctx.mint)) {
    const reason =
      intel < ABLATION_THRESHOLDS.intelFloor
        ? `v2: intelligence ${intel.toFixed(2)} < ${ABLATION_THRESHOLDS.intelFloor}`
        : `v2: rug ${rug.toFixed(2)} ≥ ${ABLATION_THRESHOLDS.rugVeto} (hard veto)`;
    return { allow: false, reason, gateConfidence: null, insiderBoost: false };
  }
  return {
    allow: true,
    reason: `v2 entry (intel ${intel.toFixed(2)}, rug ${rug.toFixed(2)})`,
    gateConfidence: intel,
    gateWalletConf: intel,
    gateCoinConf: intel,
    gateTimingConf: intel,
    insiderBoost: false,
  };
}

export const CONFLUENCE_MIN: Record<string, number> = {
  BUY_STRONG: 0.56,
  BUY_MODERATE: 0.48,
};

export type EntryContext = {
  mint: string;
  action: string;
  confluenceScore: number;
  moduleScores: Record<string, number> | null;
  vSol: number | null;
  sizeSol: number;
  ageSeconds?: number | null;
  flow?: {
    buys5m: number | null;
    sells5m: number | null;
    uniqueBuyers5m: number | null;
    buyVol5m?: number | null;
    sellVol5m?: number | null;
    curveVelocity5m?: number | null;
  };
  flags?: MintFlags | null;
  insider?: InsiderAnalysis;
  takeProfitPct?: number;
};

export type EntryFilterResult = {
  allow: boolean;
  reason: string;
  gateConfidence: number | null;
  gateWalletConf?: number;
  gateCoinConf?: number;
  gateTimingConf?: number;
  insiderBoost: boolean;
};

export type QualifyEntryOpts = {
  /** Demo paper: slightly lower bars so auto-trader can observe entries (AUTO_DEMO_RELAX). */
  demoRelaxed?: boolean;
};

export function passesConfluence(ctx: EntryContext, demoRelaxed = false): EntryFilterResult {
  const min = CONFLUENCE_MIN[ctx.action];
  if (min == null) return { allow: true, reason: "not a buy", gateConfidence: null, insiderBoost: false };
  const boost = ctx.insider?.hasStrongInsiderEntry ? 0.03 : ctx.insider?.hasInsiderEntry ? 0.02 : 0;

  // A6 launch-tier de-bias: a fresh launch's confluence is low by definition (it's
  // ≈ graduation progress), so a maturity-keyed floor gates out fast newborns. For a
  // launch-tier mint (engine_a / very young in a launch-permitting mode) with organic
  // flow, scale a bounded floor reduction by maturity-independent launch quality, so
  // velocity — not graduation — decides. Module/rug/bundle vetoes still apply downstream.
  const launchTier =
    allowsLaunchTier() &&
    ((ctx.moduleScores?._engine_a ?? 0) >= 1 || (ctx.ageSeconds ?? 99_999) < 180);
  const organicFlow =
    (ctx.flow?.buys5m ?? 0) > (ctx.flow?.sells5m ?? 0) && (ctx.flow?.uniqueBuyers5m ?? 0) >= 3;
  // Only relax the launch floor while fresh launches are proving profitable (the
  // learner keeps the relaxed tier on). If it has been disabled for poor expectancy,
  // launches face the full floor — focus shifts to proven signals.
  const launchBoost =
    launchTier && organicFlow && relaxedTierEnabled()
      ? 0.1 *
        launchQualityScore({
          velocity: ctx.flow?.curveVelocity5m ?? null,
          uniqueBuyers5m: ctx.flow?.uniqueBuyers5m,
          buys5m: ctx.flow?.buys5m,
          sells5m: ctx.flow?.sells5m,
        })
      : 0;

  const relaxedMin = demoRelaxed ? Math.max(0.36, min - 0.12) : min;
  // A high-velocity launch may relax further, but never below a hard quality floor.
  const hardFloor = launchBoost > 0 ? 0.3 : demoRelaxed ? 0.36 : 0.42;
  const effectiveMin = Math.max(hardFloor, relaxedMin - boost - launchBoost);
  const scorePct = Math.round(ctx.confluenceScore * 100);
  const minPct = Math.round(effectiveMin * 100);
  if (scorePct < minPct) {
    return {
      allow: false,
      reason: `confluence ${ctx.confluenceScore.toFixed(2)} < ${effectiveMin.toFixed(2)}`,
      gateConfidence: null,
      insiderBoost: boost > 0,
    };
  }
  return {
    allow: true,
    reason:
      launchBoost > 0.005
        ? `confluence OK (launch boost −${launchBoost.toFixed(2)})`
        : boost > 0
          ? `confluence OK (insider boost −${boost.toFixed(2)})`
          : "confluence OK",
    gateConfidence: null,
    insiderBoost: boost > 0,
  };
}

export function passesModuleVetoes(ctx: EntryContext, demoRelaxed = false): EntryFilterResult {
  const ms = ctx.moduleScores ?? {};
  const insider = ms.M2_INSIDER ?? 0;
  const wash = ms.M5_WASH ?? 0;
  const creator = ms.M4_CREATOR ?? 0;
  const rug = ms.M3_RUG ?? 0;

  if (insider >= 0.58) {
    return { allow: false, reason: `insider concentration ${insider.toFixed(2)}`, gateConfidence: null, insiderBoost: false };
  }
  if (wash >= 0.65) {
    return { allow: false, reason: `wash trading ${wash.toFixed(2)}`, gateConfidence: null, insiderBoost: false };
  }
  if (creator >= 0.65 && ctx.action === "BUY_STRONG") {
    return { allow: false, reason: `creator risk ${creator.toFixed(2)}`, gateConfidence: null, insiderBoost: false };
  }
  // Hard rug ceiling: a near-certain rug is NEVER worth buying — not even with a
  // strong insider-entry signal. (A rugScore=0.95 token was entered via the insider
  // exemption below and lost 72%.) This ceiling cannot be bypassed.
  if (rug >= 0.7) {
    return { allow: false, reason: `rug score ${rug.toFixed(2)} (hard veto)`, gateConfidence: null, insiderBoost: false };
  }
  const rugCap = demoRelaxed ? 0.55 : 0.38;
  if (rug >= rugCap && !ctx.insider?.hasStrongInsiderEntry) {
    return { allow: false, reason: `rug score ${rug.toFixed(2)}`, gateConfidence: null, insiderBoost: false };
  }
  return { allow: true, reason: "module scores OK", gateConfidence: null, insiderBoost: false };
}

/** Demo auto-trader: minimal bar so paper sessions actually open (AUTO_DEMO_RELAX). */
export async function qualifyDemoAutoEntry(ctx: EntryContext): Promise<EntryFilterResult> {
  const age = ctx.ageSeconds ?? 99_999;
  const minConf =
    age < 600
      ? ctx.action === "BUY_STRONG"
        ? 0.38
        : 0.32
      : ctx.action === "BUY_STRONG"
        ? 0.44
        : 0.36;
  const scorePct = Math.round(ctx.confluenceScore * 100);
  const minPct = Math.round(minConf * 100);
  if (scorePct < minPct) {
    return {
      allow: false,
      reason: `confluence ${ctx.confluenceScore.toFixed(2)} < ${minConf.toFixed(2)}`,
      gateConfidence: null,
      insiderBoost: false,
    };
  }
  const mods = passesModuleVetoes(ctx, true);
  if (!mods.allow) return mods;
  if (ctx.vSol == null || ctx.vSol <= 0) {
    return { allow: false, reason: "no vSol for entry", gateConfidence: null, insiderBoost: false };
  }
  const conf = Math.max(0.45, ctx.confluenceScore);
  return {
    allow: true,
    reason: "demo auto pass",
    gateConfidence: conf,
    gateWalletConf: conf,
    gateCoinConf: conf,
    gateTimingConf: conf,
    insiderBoost: false,
  };
}

export async function qualifyEntry(
  ctx: EntryContext,
  opts?: QualifyEntryOpts,
): Promise<EntryFilterResult> {
  // V2-simple entry mode short-circuits the full gate stack (incl. demo-relax path):
  // the validated intelligence + rug-veto rule is the entire entry decision.
  if (isV2SimpleEntry()) return qualifyV2Entry(ctx);

  const demoRelaxed = opts?.demoRelaxed ?? false;
  if (demoRelaxed) return qualifyDemoAutoEntry(ctx);

  const conf = passesConfluence(ctx, false);
  if (!conf.allow) return conf;
  const mods = passesModuleVetoes(ctx, false);
  if (!mods.allow) return mods;

  if (ctx.flags?.hasBundle || ctx.flags?.mechanicalUptrend) {
    return { allow: false, reason: "bundle/mechanical veto", gateConfidence: null, insiderBoost: false };
  }

  const buyers = (await fetchBuyerProfilesForMint(ctx.mint, 5)).map((b) => ({
    tStat: b.t_stat,
    avgReturn: b.avg_return,
    stdReturn: b.std_return,
    tradeCount: b.trade_count,
    isBumpBot: b.is_bump_bot,
    sniperRate: b.sniper_rate,
    bundleRate: b.bundle_rate,
  }));
  const profitMode = isProfitSignalMode();
  // Fresh-launch (newborn) tier: an Engine-A launch signal or a very young mint
  // in a mode that permits launch entries. Such tokens have low curve-graduation
  // by definition, so the smart-money wallet gate and graduation floor are the
  // wrong gates — we lean on organic flow + rug/bundle vetoes instead. (Hardened
  // further by the launch-velocity model in L2.1 and anti-rug in L2.3.)
  const isLaunchTier =
    allowsLaunchTier() &&
    ((ctx.moduleScores?._engine_a ?? 0) >= 1 || (ctx.ageSeconds ?? 99_999) < 180);
  // Relaxed (non-strict) entry path: profit/hybrid modes, or any launch-tier mint.
  const relaxed = profitMode || isLaunchTier;
  const flowOk =
    (ctx.flow?.buys5m ?? 0) > (ctx.flow?.sells5m ?? 0) && (ctx.flow?.uniqueBuyers5m ?? 0) >= 3;
  const wallet =
    relaxed && (buyers.length === 0 || flowOk)
      ? {
          pass: true,
          confidence: flowOk ? 0.62 : 0.55,
          reasons: [flowOk ? "organic flow (relaxed mode)" : "flow-only mode (no wallet profiles)"],
        }
      : walletGate(buyers);
  const rawGrad = ctx.moduleScores?.M1_GRADUATION ?? 0.5;
  const coin = coinGate({
    flags: ctx.flags ?? null,
    gradScore: rawGrad,
    rugScore: ctx.moduleScores?.M3_RUG ?? 0,
    curveVelocity5m: ctx.flow?.curveVelocity5m ?? null,
    buys5m: ctx.flow?.buys5m ?? null,
    sells5m: ctx.flow?.sells5m ?? null,
    buyVol5m: ctx.flow?.buyVol5m ?? null,
    sellVol5m: ctx.flow?.sellVol5m ?? null,
    uniqueBuyers5m: ctx.flow?.uniqueBuyers5m ?? null,
    // Newborns sit low on the curve — use a launch-tier graduation floor and let
    // organic flow + rug/bundle vetoes carry the quality judgement.
    minGradScore: isLaunchTier ? 0.12 : profitMode ? 0.45 : undefined,
    maxRugScore: relaxed ? 0.38 : undefined,
  });
  const timing = timingGate({
    ageSeconds: ctx.ageSeconds ?? null,
    vSol: ctx.vSol,
    sizeSol: ctx.sizeSol,
    ageSecondsP75: relaxed ? 14_400 : undefined,
    vSolP25: relaxed ? 5 : undefined,
  });
  const weights = await readActiveGateWeights();
  const agg = aggregateGates({ wallet, coin, timing, weights });

  const gatesPass = relaxed
    ? coin.pass && timing.pass && (wallet.pass || flowOk)
    : agg.pass;

  const tp = ctx.takeProfitPct ?? 0.5;
  const penalty = imitationPenaltyPct(ctx.sizeSol, ctx.vSol ?? 0);
  const insiderEdge = ctx.insider?.hasStrongInsiderEntry ? 0.05 : ctx.insider?.hasInsiderEntry ? 0.02 : 0;
  const gateConfidence =
    relaxed && gatesPass && !agg.pass
      ? Math.min(1, (coin.confidence + timing.confidence + wallet.confidence) / 3)
      : agg.confidence;
  const expectedEdge = tp * gateConfidence - penalty + insiderEdge;

  const minEdge = relaxed ? 0.015 : 0.03;
  if (!gatesPass || expectedEdge < minEdge) {
    return {
      allow: false,
      reason: agg.reasons.join(" | ") || `edge ${expectedEdge.toFixed(3)} < ${minEdge}`,
      gateConfidence,
      gateWalletConf: agg.wallet.confidence,
      gateCoinConf: agg.coin.confidence,
      gateTimingConf: agg.timing.confidence,
      insiderBoost: insiderEdge > 0,
    };
  }

  return {
    allow: true,
    reason: ctx.insider?.hasInsiderEntry
      ? `gates pass · ${ctx.insider.smartMoneyCount} smart wallet(s)`
      : "gates pass",
    gateConfidence,
    gateWalletConf: agg.wallet.confidence,
    gateCoinConf: agg.coin.confidence,
    gateTimingConf: agg.timing.confidence,
    insiderBoost: insiderEdge > 0,
  };
}

/** @deprecated Use qualifyEntry(ctx, { demoRelaxed: true }). */
export async function qualifyDemoAutoEntryLegacy(ctx: EntryContext): Promise<EntryFilterResult> {
  return qualifyEntry(ctx, { demoRelaxed: true });
}
