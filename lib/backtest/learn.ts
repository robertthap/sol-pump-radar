import "server-only";
import { runBacktest, type BacktestParams, type BacktestSummary } from "@/lib/backtest/runner";

export type BacktestLearnInsight = {
  kind: "tp_sl" | "filter" | "action";
  message: string;
  severity: "good" | "warn" | "info";
};

export type BacktestLearnResult = {
  best: BacktestSummary & { label: string };
  alternatives: Array<{
    label: string;
    takeProfitPct: number;
    stopLossPct: number;
    maxHoldMinutes: number;
    winRate: number;
    totalPnlSol: number;
    expectancySol: number;
    entered: number;
  }>;
  insights: BacktestLearnInsight[];
  durationMs: number;
};

const TP_GRID = [0.25, 0.32, 0.4, 0.5];
const SL_GRID = [0.1, 0.12, 0.15, 0.18];
const HOLD_GRID = [30, 40, 50];

/** Grid-search TP/SL/hold using live-aligned entry filters; ranks by expectancy. */
export async function runBacktestLearn(
  base: Pick<
    BacktestParams,
    "windowHours" | "sizeSol" | "maxTrades" | "enableBotVetoes" | "enableRingVetoes" | "enableRugLabelVeto"
  >,
): Promise<BacktestLearnResult> {
  const t0 = Date.now();
  const runs: Array<{ label: string; summary: BacktestSummary; tp: number; sl: number; hold: number }> = [];

  for (const tp of TP_GRID) {
    for (const sl of SL_GRID) {
      for (const hold of HOLD_GRID) {
        const summary = await runBacktest({
          windowHours: base.windowHours,
          sizeSol: base.sizeSol,
          maxTrades: base.maxTrades ?? 400,
          actionFilter: ["BUY_STRONG", "BUY_MODERATE"],
          enableBotVetoes: base.enableBotVetoes ?? true,
          enableRingVetoes: base.enableRingVetoes ?? true,
          enableRugLabelVeto: base.enableRugLabelVeto ?? true,
          enableEntryFilter: true,
          strongOnly: false,
          takeProfitPct: tp,
          stopLossPct: sl,
          maxHoldMinutes: hold,
          tp1Pct: Math.min(tp * 0.5, tp - 0.02),
          tp1Fraction: 0.5,
        });
        runs.push({
          label: `TP ${Math.round(tp * 100)}% · SL ${Math.round(sl * 100)}% · ${hold}m`,
          summary,
          tp,
          sl,
          hold,
        });
      }
    }
  }

  runs.sort((a, b) => {
    const ea = a.summary.overall.expectancySol;
    const eb = b.summary.overall.expectancySol;
    if (eb !== ea) return eb - ea;
    return b.summary.overall.winRate - a.summary.overall.winRate;
  });

  const bestRun = runs[0]!;
  const insights: BacktestLearnInsight[] = [];

  if (bestRun.summary.overall.closed < 10) {
    insights.push({
      kind: "filter",
      message: "Few closed trades in window — widen hours or relax vetoes for more samples.",
      severity: "warn",
    });
  } else if (bestRun.summary.overall.expectancySol > 0) {
    insights.push({
      kind: "tp_sl",
      message: `Best expectancy ${bestRun.summary.overall.expectancySol.toFixed(4)} SOL/trade at ${bestRun.label}.`,
      severity: "good",
    });
  } else {
    insights.push({
      kind: "tp_sl",
      message: "No TP/SL combo was profitable in this window — tighten entry filters or shorten window.",
      severity: "warn",
    });
  }

  const slExits = bestRun.summary.byExitReason.filter((e) => e.exitReason.startsWith("sl"));
  const slPnl = slExits.reduce((a, e) => a + e.totalPnlSol, 0);
  if (slExits.reduce((a, e) => a + e.n, 0) > bestRun.summary.overall.closed * 0.45) {
    insights.push({
      kind: "tp_sl",
      message: "Stop-loss exits dominate — consider wider SL or stricter confluence filter.",
      severity: "warn",
    });
  } else if (slPnl < 0 && Math.abs(slPnl) > Math.abs(bestRun.summary.overall.totalPnlSol) * 0.5) {
    insights.push({
      kind: "tp_sl",
      message: "Most losses come from SL — auto-trader SL may be too tight for current volatility.",
      severity: "info",
    });
  }

  const strong = bestRun.summary.byAction.find((a) => a.action === "BUY_STRONG");
  const moderate = bestRun.summary.byAction.find((a) => a.action === "BUY_MODERATE");
  if (strong && moderate && strong.n >= 5 && moderate.n >= 5) {
    if ((strong.winRate ?? 0) > (moderate.winRate ?? 0) + 0.12) {
      insights.push({
        kind: "action",
        message: "BUY_STRONG outperforms BUY_MODERATE — use strong-only auto-trader preset.",
        severity: "good",
      });
    } else if ((moderate.winRate ?? 0) > (strong.winRate ?? 0) + 0.08) {
      insights.push({
        kind: "action",
        message: "BUY_MODERATE beats strong in this window — balanced preset may capture more edge.",
        severity: "info",
      });
    }
  }

  const filtered = bestRun.summary.filtered.reduce((a, f) => a + f.count, 0);
  if (filtered > bestRun.summary.overall.candidates * 0.6) {
    insights.push({
      kind: "filter",
      message: `${filtered} candidates filtered — entry gates are doing heavy lifting (good for live, fewer backtest trades).`,
      severity: "info",
    });
  }

  return {
    best: { ...bestRun.summary, label: bestRun.label },
    alternatives: runs.slice(1, 6).map((r) => ({
      label: r.label,
      takeProfitPct: r.tp,
      stopLossPct: r.sl,
      maxHoldMinutes: r.hold,
      winRate: r.summary.overall.winRate,
      totalPnlSol: r.summary.overall.totalPnlSol,
      expectancySol: r.summary.overall.expectancySol,
      entered: r.summary.overall.entered,
    })),
    insights,
    durationMs: Date.now() - t0,
  };
}
