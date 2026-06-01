import "server-only";
import { logger } from "@/lib/log";
import { computeActiveFeatures, persistFeatureSnapshot, type MintFeatureRow } from "@/lib/db/repos/features";
import { scoreGraduation, scoreGraduationContinuation } from "@/lib/modules/m1-graduation";
import { scoreRug } from "@/lib/modules/m3-rug";
import { scoreInsider } from "@/lib/modules/m2-insider";
import { scoreCreator } from "@/lib/modules/m4-creator";
import { scoreWash } from "@/lib/modules/m5-wash";
import { isProfitSignalMode } from "@/lib/env";
import { touchWorker } from "@/lib/workers/heartbeat";

const log = logger("analytics");

const TICK_MS = 5_000;

declare global {
  // eslint-disable-next-line no-var
  var __spr_analytics_snapshot__: AnalyticsSnapshot | undefined;
}

export type ScoredMint = {
  mint: string;
  gradScore: number;
  rugScore: number;
  insiderScore: number;
  creatorRiskScore: number;
  washScore: number;
  confluenceScore: number;
  gradReasons: string[];
  rugReasons: string[];
  insiderReasons: string[];
  creatorReasons: string[];
  washReasons: string[];
  features: MintFeatureRow;
};

export type AnalyticsSnapshot = {
  ts: number;
  durationMs: number;
  active: number;
  scored: ScoredMint[];
};

export function getAnalyticsSnapshot(): AnalyticsSnapshot | null {
  return globalThis.__spr_analytics_snapshot__ ?? null;
}

export async function startAnalytics() {
  log.info("analytics starting", { intervalMs: TICK_MS });
  let running = false;

  async function tick() {
    if (running) return;
    running = true;
    const t0 = Date.now();
    try {
      const rows = await computeActiveFeatures();
      const profitMode = isProfitSignalMode();
      const scored: ScoredMint[] = rows.map((f) => {
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
          profitMode && (f.ageSeconds ?? 0) > 600 && (f.buys5m > f.sells5m || (gradInput.curveVelocity5m ?? 0) > 0.3);
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

        // Combined "buy this?" confluence: positive momentum (M1) penalised by
        // every risk module. Hard veto when bundle / mechanical uptrend.
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
      });

      await persistFeatureSnapshot(
        scored.map((s) => ({
          mint: s.mint,
          features: s.features,
          gradScore: s.gradScore,
          rugScore: s.rugScore,
          insiderScore: s.insiderScore,
          creatorRiskScore: s.creatorRiskScore,
          washScore: s.washScore,
          confluenceScore: s.confluenceScore,
        })),
      );

      globalThis.__spr_analytics_snapshot__ = {
        ts: t0,
        durationMs: Date.now() - t0,
        active: scored.length,
        scored,
      };
    } catch (e) {
      log.error("tick failed", { err: String(e) });
    } finally {
      touchWorker("analytics", { tickMs: Date.now() - t0 });
      running = false;
    }
  }

  const interval = setInterval(() => {
    tick().catch((e) => log.error("tick rejected", { err: String(e) }));
  }, TICK_MS);
  setTimeout(() => tick().catch(() => undefined), 2_000);

  return () => clearInterval(interval);
}
