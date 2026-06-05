import "server-only";
import { logger } from "@/lib/log";
import { env, allowsLaunchTier } from "@/lib/env";
import {
  attributeOutcomes,
  fetchActionPerformance,
  fetchExitReasonPerformance,
  fetchModuleBucketPerformance,
  fetchUnattributedPaperTrades,
  type ActionPerf,
  type ExitReasonPerf,
  type ModuleBucketPerf,
} from "@/lib/db/repos/outcomes";
import {
  fetchOverall,
  fetchByExitReason,
  fetchByAction,
  fetchByGradBucket,
  fetchByRugBucket,
  fetchTierOverall,
  type OverallStats,
  type ByExitReasonRow,
  type ByActionRow,
  type ByScoreBucketRow,
} from "@/lib/db/repos/performance";
import {
  shouldEnableRelaxedTier,
  setRelaxedTierEnabled,
  relaxedTierEnabled,
} from "@/lib/trade/tier-control";
import {
  readActiveOverrides,
  readActiveGateWeights,
  recordChange,
  type ThresholdDiff,
} from "@/lib/db/repos/tuner";
import {
  attributeLossPostmortems,
  mineLossPatterns,
  mineWinningPatterns,
  recordLearnedRule,
  type WinPattern,
} from "@/lib/db/repos/loss-learning";
import { fetchGateOutcomes } from "@/lib/db/repos/gate-stats";

const log = logger("learner");
const ATTRIBUTION_TICK_MS = 15_000;
const TUNE_TICK_MS = 5 * 60_000;
const MIN_SAMPLES_PER_ACTION = 15;
const MAX_DEVIATION_FROM_PRESET = 0.15;
const CHANGE_COOLDOWN_MS = 60 * 60_000;

export type LearningSnapshot = {
  ts: number;
  actionPerf: ActionPerf[];
  moduleBuckets: ModuleBucketPerf[];
  exitReasons: ExitReasonPerf[];
  attributedSinceBoot: number;
  lastTuneAt: number | null;
};

export type PerformanceSnapshot = {
  ts: number;
  overall: OverallStats;
  byExitReason: ByExitReasonRow[];
  byAction: ByActionRow[];
  byGradBucket: ByScoreBucketRow[];
  byRugBucket: ByScoreBucketRow[];
};

declare global {
  // eslint-disable-next-line no-var
  var __spr_learning_snapshot__: LearningSnapshot | undefined;
  // eslint-disable-next-line no-var
  var __spr_performance_snapshot__: PerformanceSnapshot | undefined;
  // eslint-disable-next-line no-var
  var __spr_winning_patterns__: { ts: number; patterns: WinPattern[] } | undefined;
}

export function getWinningPatterns(): WinPattern[] {
  return globalThis.__spr_winning_patterns__?.patterns ?? [];
}

export function getLearningSnapshot(): LearningSnapshot | null {
  return globalThis.__spr_learning_snapshot__ ?? null;
}

export function getPerformanceSnapshot(): PerformanceSnapshot | null {
  return globalThis.__spr_performance_snapshot__ ?? null;
}

type DecisionPresetDefaults = ReturnType<typeof presetThresholdDefaults>;

function presetThresholdDefaults(preset: string) {
  switch (preset) {
    case "conservative":
      return { gradBuyStrong: 0.85, gradBuyModerate: 0.7, gradWatch: 0.5, rugBuyCap: 0.15, rugAvoid: 0.4 };
    case "aggressive":
      return { gradBuyStrong: 0.65, gradBuyModerate: 0.5, gradWatch: 0.35, rugBuyCap: 0.35, rugAvoid: 0.6 };
    default:
      return { gradBuyStrong: 0.75, gradBuyModerate: 0.6, gradWatch: 0.45, rugBuyCap: 0.25, rugAvoid: 0.5 };
  }
}

function within(value: number, defaultVal: number): boolean {
  return Math.abs(value - defaultVal) <= MAX_DEVIATION_FROM_PRESET;
}

function clamp(x: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, x));
}

type Proposal = { diff: ThresholdDiff; reason: string };

function proposeTunes(
  actionPerf: ActionPerf[],
  overrides: ThresholdDiff,
  defaults: DecisionPresetDefaults,
  moduleBuckets: ModuleBucketPerf[],
  exitReasons: ExitReasonPerf[],
): Proposal[] {
  const out: Proposal[] = [];

  for (const [action, defaultKey] of [
    ["BUY_MODERATE", "gradBuyModerate" as const],
    ["BUY_STRONG", "gradBuyStrong" as const],
  ] as const) {
    const p = actionPerf.find((x) => x.action === action);
    if (!p || p.n < MIN_SAMPLES_PER_ACTION) continue;
    const winRate = p.winRate ?? 0;
    const current = overrides[defaultKey] ?? defaults[defaultKey];
    let next: number | null = null;
    let reason = "";
    if (winRate < 0.3) {
      // In launch/hybrid mode, fresh-launch decisions have inherently low grad early;
      // raising the grad bar here starves the newborn tier (the whole point of launch mode).
      // Only allow tightening the BUY_STRONG bar, never BUY_MODERATE, while launch tier is on.
      if (allowsLaunchTier() && action === "BUY_MODERATE") continue;
      next = clamp(current + 0.03, defaults[defaultKey] - MAX_DEVIATION_FROM_PRESET, defaults[defaultKey] + MAX_DEVIATION_FROM_PRESET);
      reason = `${action} win rate ${(winRate * 100).toFixed(0)}% on ${p.n} trades — raise threshold ${current.toFixed(2)}→${next.toFixed(2)}`;
    } else if (winRate > 0.65) {
      next = clamp(current - 0.02, defaults[defaultKey] - MAX_DEVIATION_FROM_PRESET, defaults[defaultKey] + MAX_DEVIATION_FROM_PRESET);
      reason = `${action} win rate ${(winRate * 100).toFixed(0)}% on ${p.n} trades — lower threshold ${current.toFixed(2)}→${next.toFixed(2)}`;
    }
    if (next != null && Math.abs(next - current) >= 0.01 && within(next, defaults[defaultKey])) {
      out.push({ diff: { [defaultKey]: next } as ThresholdDiff, reason });
    }
  }

  const highRug = moduleBuckets.find(
    (b) => b.module === "M3_RUG" && b.bucketMin >= 0.35 && b.n >= 12,
  );
  if (highRug && (highRug.winRate ?? 1) < 0.35) {
    const current = overrides.rugBuyCap ?? defaults.rugBuyCap;
    const next = clamp(current - 0.03, defaults.rugBuyCap - MAX_DEVIATION_FROM_PRESET, defaults.rugBuyCap);
    if (Math.abs(next - current) >= 0.01) {
      out.push({
        diff: { rugBuyCap: next },
        reason: `High rug bucket win ${((highRug.winRate ?? 0) * 100).toFixed(0)}% on ${highRug.n} — tighten rug cap ${current.toFixed(2)}→${next.toFixed(2)}`,
      });
    }
  }

  const slHeavy = exitReasons.filter((e) => e.reason.startsWith("sl") || e.reason.includes("sl"));
  const slN = slHeavy.reduce((a, e) => a + e.n, 0);
  const slPnl = slHeavy.reduce((a, e) => a + e.totalPnlSol, 0);
  const totalN = exitReasons.reduce((a, e) => a + e.n, 0);
  if (totalN >= 20 && slN > totalN * 0.4 && slPnl < 0) {
    out.push({
      diff: {},
      reason: `Stop-loss exits ${slN}/${totalN} (${((slN / totalN) * 100).toFixed(0)}%) — consider wider SL or stricter entries (logged for review)`,
    });
  }

  return out;
}

export async function startLearner() {
  log.info("learner starting", {
    attributionMs: ATTRIBUTION_TICK_MS,
    tuneMs: TUNE_TICK_MS,
    autoTune: env().AUTO_TUNE,
  });

  let attributedTotal = 0;
  let lastTuneAt: number | null = null;
  let lastAutoApplyAt = 0;

  async function perfTick() {
    try {
      const [overall, byExitReason, byAction, byGradBucket, byRugBucket] = await Promise.all([
        fetchOverall(),
        fetchByExitReason(),
        fetchByAction(),
        fetchByGradBucket(),
        fetchByRugBucket(),
      ]);
      globalThis.__spr_performance_snapshot__ = {
        ts: Date.now(),
        overall,
        byExitReason,
        byAction,
        byGradBucket,
        byRugBucket,
      };
    } catch (e) {
      log.warn("perf tick failed", { err: String(e) });
    }
  }

  async function attributeTick() {
    try {
      const todo = await fetchUnattributedPaperTrades(200);
      if (todo.length > 0) {
        const n = await attributeOutcomes(todo);
        attributedTotal += n;
        if (n > 0) log.info("attributed outcomes", { n, attributedTotal });
      }
      const lpm = await attributeLossPostmortems(100);
      if (lpm > 0) log.info("loss postmortems captured", { n: lpm });
    } catch (e) {
      log.error("attribution tick failed", { err: String(e) });
    }
  }

  async function gateWeightTick() {
    try {
      const rows = await fetchGateOutcomes(24 * 14, 500);
      if (rows.length < 30) {
        log.debug("gate-weight tune: insufficient samples", { n: rows.length });
        return;
      }
      // Pearson correlation between each gate's confidence and PnL.
      const corr = (xs: number[], ys: number[]): number => {
        const n = xs.length;
        if (n === 0) return 0;
        const mx = xs.reduce((a, b) => a + b, 0) / n;
        const my = ys.reduce((a, b) => a + b, 0) / n;
        let num = 0, dx = 0, dy = 0;
        for (let i = 0; i < n; i++) {
          const a = xs[i]! - mx;
          const b = ys[i]! - my;
          num += a * b;
          dx += a * a;
          dy += b * b;
        }
        const den = Math.sqrt(dx * dy);
        return den === 0 ? 0 : num / den;
      };

      const w_w = corr(rows.map((r) => r.walletConf), rows.map((r) => r.pnlSol));
      const c_w = corr(rows.map((r) => r.coinConf),   rows.map((r) => r.pnlSol));
      const t_w = corr(rows.map((r) => r.timingConf), rows.map((r) => r.pnlSol));

      // Map correlations to non-negative weights using softmax on a 10x scale.
      // Negative correlations get pushed toward zero (gate is anti-predictive).
      const expSafe = (x: number) => Math.exp(Math.max(-5, Math.min(5, 10 * x)));
      const ew = expSafe(w_w);
      const ec = expSafe(c_w);
      const et = expSafe(t_w);
      const sum = ew + ec + et;
      const target = { wallet: ew / sum, coin: ec / sum, timing: et / sum };

      const current = await readActiveGateWeights();
      // Bound deviation from default 0.4/0.4/0.2: never let a gate's weight
      // drop below 0.1 or rise above 0.7.
      const bound = (v: number) => Math.max(0.1, Math.min(0.7, v));
      const proposed = {
        wallet: bound(target.wallet),
        coin: bound(target.coin),
        timing: bound(target.timing),
      };
      const psum = proposed.wallet + proposed.coin + proposed.timing;
      proposed.wallet /= psum;
      proposed.coin /= psum;
      proposed.timing /= psum;

      const dW = Math.abs(proposed.wallet - current.wallet);
      const dC = Math.abs(proposed.coin - current.coin);
      const dT = Math.abs(proposed.timing - current.timing);
      const maxDelta = Math.max(dW, dC, dT);
      if (maxDelta < 0.04) {
        log.debug("gate weights stable", { current, proposed, maxDelta });
        return;
      }

      const reason = `gate-weight tune (corrs w=${w_w.toFixed(2)} c=${c_w.toFixed(2)} t=${t_w.toFixed(2)} on ${rows.length} trades): ${current.wallet.toFixed(2)}/${current.coin.toFixed(2)}/${current.timing.toFixed(2)} → ${proposed.wallet.toFixed(2)}/${proposed.coin.toFixed(2)}/${proposed.timing.toFixed(2)}`;
      const apply = env().AUTO_TUNE === "on";
      await recordChange({
        diff: {
          gateWeightWallet: proposed.wallet,
          gateWeightCoin: proposed.coin,
          gateWeightTiming: proposed.timing,
        },
        reason,
        metricsBefore: { current, corrs: { w: w_w, c: c_w, t: t_w }, n: rows.length },
        metricsAfter: { proposed },
        applied: apply,
      });
      if (apply) {
        log.warn("gate weights tuned (applied)", { proposed, corrs: { w: w_w, c: c_w, t: t_w } });
      } else {
        log.info("gate weights tuned (proposed only)", { proposed, corrs: { w: w_w, c: c_w, t: t_w } });
      }
    } catch (e) {
      log.warn("gate-weight tick failed", { err: String(e) });
    }
  }

  async function lossMineTick() {
    try {
      const patterns = await mineLossPatterns(24 * 7);
      if (patterns.length === 0) return;
      const auto = env().AUTO_TUNE === "on";
      let recorded = 0;
      for (const p of patterns.slice(0, 5)) {
        const id = await recordLearnedRule(p, auto ? "applied" : "proposed");
        if (id != null) {
          recorded++;
          log.info(auto ? "loss rule applied" : "loss rule proposed", {
            featureKey: p.featureKey,
            op: p.operator,
            threshold: p.threshold,
            n: p.sampleN,
            lossRate: p.lossRate.toFixed(2),
          });
        }
      }
      if (recorded === 0) log.debug("no new loss patterns");

      // Symmetric "seek" patterns — what actually precedes profit (L5.3).
      const winners = await mineWinningPatterns(24 * 7);
      globalThis.__spr_winning_patterns__ = { ts: Date.now(), patterns: winners };
      if (winners.length > 0) {
        for (const w of winners.slice(0, 5)) {
          log.info("winning pattern", {
            featureKey: w.featureKey, op: w.operator, threshold: w.threshold,
            n: w.sampleN, winRate: w.winRate.toFixed(2), avgPnl: w.avgPnlSol.toFixed(4),
          });
        }
      }
    } catch (e) {
      log.warn("loss mine tick failed", { err: String(e) });
    }
  }

  async function tierTick() {
    try {
      const [strict, relaxed] = await Promise.all([
        fetchTierOverall("strict", 24 * 7),
        fetchTierOverall("relaxed", 24 * 7),
      ]);
      const decision = shouldEnableRelaxedTier(
        { trades: strict.trades, winRate: strict.winRate, expectancySol: strict.expectancySol },
        { trades: relaxed.trades, winRate: relaxed.winRate, expectancySol: relaxed.expectancySol },
      );
      const was = relaxedTierEnabled();
      setRelaxedTierEnabled(decision.enabled);
      if (was !== decision.enabled) {
        log.warn("relaxed tier toggled", {
          enabled: decision.enabled,
          reason: decision.reason,
          strict: { n: strict.trades, win: strict.winRate, exp: strict.expectancySol },
          relaxed: { n: relaxed.trades, win: relaxed.winRate, exp: relaxed.expectancySol },
        });
      } else {
        log.debug("relaxed tier unchanged", { enabled: decision.enabled, reason: decision.reason });
      }
    } catch (e) {
      log.warn("tier tick failed", { err: String(e) });
    }
  }

  async function tuneTick() {
    try {
      const [actionPerf, moduleBuckets, exitReasons, overrides] = await Promise.all([
        fetchActionPerformance(24),
        fetchModuleBucketPerformance(24),
        fetchExitReasonPerformance(24),
        readActiveOverrides(),
      ]);
      globalThis.__spr_learning_snapshot__ = {
        ts: Date.now(),
        actionPerf,
        moduleBuckets,
        exitReasons,
        attributedSinceBoot: attributedTotal,
        lastTuneAt,
      };

      const defaults = presetThresholdDefaults(env().RISK_PRESET);
      const proposals = proposeTunes(actionPerf, overrides, defaults, moduleBuckets, exitReasons);
      if (proposals.length === 0) return;

      const autoApply = env().AUTO_TUNE === "on";
      const sinceLast = Date.now() - lastAutoApplyAt;
      if (autoApply && sinceLast < CHANGE_COOLDOWN_MS) {
        log.info("auto-tune cooldown active", { sinceLastMs: sinceLast });
      }

      for (const p of proposals) {
        const applied = autoApply && sinceLast >= CHANGE_COOLDOWN_MS;
        await recordChange({
          diff: p.diff,
          reason: p.reason,
          metricsBefore: { actionPerf, overrides },
          applied,
        });
        if (applied) {
          lastAutoApplyAt = Date.now();
          lastTuneAt = Date.now();
          log.warn("auto-tune applied", { diff: p.diff, reason: p.reason });
        } else {
          log.info("proposal logged (not applied)", { diff: p.diff, reason: p.reason });
        }
      }
    } catch (e) {
      log.error("tune tick failed", { err: String(e) });
    }
  }

  const attrInterval = setInterval(() => {
    attributeTick().catch(() => undefined);
  }, ATTRIBUTION_TICK_MS);
  const tuneInterval = setInterval(() => {
    tuneTick().catch(() => undefined);
  }, TUNE_TICK_MS);
  const perfInterval = setInterval(() => {
    perfTick().catch(() => undefined);
  }, 30_000);
  const lossInterval = setInterval(() => {
    lossMineTick().catch(() => undefined);
  }, 10 * 60_000);
  const gateInterval = setInterval(() => {
    gateWeightTick().catch(() => undefined);
  }, 30 * 60_000);
  const tierInterval = setInterval(() => {
    tierTick().catch(() => undefined);
  }, 5 * 60_000);

  setTimeout(() => attributeTick().catch(() => undefined), 4_000);
  setTimeout(() => tuneTick().catch(() => undefined), 20_000);
  setTimeout(() => perfTick().catch(() => undefined), 6_000);
  setTimeout(() => lossMineTick().catch(() => undefined), 90_000);
  setTimeout(() => gateWeightTick().catch(() => undefined), 120_000);
  setTimeout(() => tierTick().catch(() => undefined), 30_000);

  return () => {
    clearInterval(attrInterval);
    clearInterval(tuneInterval);
    clearInterval(perfInterval);
    clearInterval(lossInterval);
    clearInterval(gateInterval);
    clearInterval(tierInterval);
  };
}
