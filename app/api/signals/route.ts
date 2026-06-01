import { NextResponse } from "next/server";
import { bootDb } from "@/lib/db/client";
import { fetchSignalFeed, fetchDecisionCounts, fetchSignalWinStats } from "@/lib/db/repos/decisions";
import { fetchOverall, fetchAutoPaperOverall } from "@/lib/db/repos/performance";
import { cached } from "@/lib/api/short-cache";
import { sumMissedProfitSol } from "@/lib/signals/missed-profit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  await bootDb();
  const url = new URL(req.url);
  const hours = Number(url.searchParams.get("hours") ?? 24);
  const limit = Number(url.searchParams.get("limit") ?? 120);
  const action = url.searchParams.get("action");
  const mint = url.searchParams.get("mint");
  const minScore = Number(url.searchParams.get("minScore") ?? 0);
  const tradableOnly = url.searchParams.get("tradableOnly") === "1";
  const autoReadyOnly = url.searchParams.get("autoReadyOnly") === "1";
  const sortBy = url.searchParams.get("sortBy") === "score" ? "score" : "time";
  const engineBOnly = url.searchParams.get("engineB") === "1";
  const intelligenceOnly = url.searchParams.get("intelligenceOnly") === "1";
  const autoGateOnly = url.searchParams.get("autoGateOnly") === "1";

  const lite = url.searchParams.get("lite") === "1";

  const cacheKey = `signals:${hours}:${limit}:${action ?? ""}:${mint ?? ""}:${minScore}:${tradableOnly}:${autoReadyOnly}:${autoGateOnly}:${sortBy}:${lite}:${engineBOnly}:${intelligenceOnly}`;

  const { signals, counts1h, winStats, performance, autoPerf } = await cached(cacheKey, 5_000, async () => {
    const [s, c, w, p, a] = await Promise.all([
      fetchSignalFeed({
        hours,
        limit,
        action,
        mint,
        minScore: minScore > 0 ? minScore : undefined,
        tradableOnly,
        autoReadyOnly,
        autoGateOnly,
        intelligenceOnly,
        engineBOnly,
        sortBy,
        smartMoneyCap: lite ? 40 : 60,
      }),
      lite ? Promise.resolve({}) : cached("signals:counts1h", 8_000, () => fetchDecisionCounts()),
      lite ? Promise.resolve({ tracked: 0, wins: 0, winRate: null, avgChangePct: null }) : fetchSignalWinStats(hours),
      lite ? Promise.resolve({ trades: 0, wins: 0, losses: 0, winRate: null, totalPnlSol: 0, avgPnlSol: null, avgWinSol: null, avgLossSol: null, expectancySol: null, bestPnlSol: null, worstPnlSol: null, avgHoldSeconds: null }) : cached("signals:perf", 15_000, () => fetchOverall()),
      lite ? Promise.resolve({ trades: 0, wins: 0, losses: 0, winRate: null, totalPnlSol: 0, avgPnlSol: null, avgWinSol: null, avgLossSol: null, expectancySol: null, bestPnlSol: null, worstPnlSol: null, avgHoldSeconds: null }) : cached("signals:autoPerf", 15_000, () => fetchAutoPaperOverall(hours)),
    ]);
    return { signals: s, counts1h: c, winStats: w, performance: p, autoPerf: a };
  });

  const summary = {
    total: signals.length,
    buyStrong: signals.filter((s) => s.action === "BUY_STRONG").length,
    buyModerate: signals.filter((s) => s.action === "BUY_MODERATE").length,
    watch: signals.filter((s) => s.action === "WATCH").length,
    avoid: signals.filter((s) => s.action === "AVOID").length,
    withInsider: signals.filter((s) => s.insiderSignal).length,
    hot: signals.filter((s) => s.qualityTier === "hot").length,
    tradable: signals.filter((s) => s.tradable).length,
    autoReady: signals.filter((s) => s.autoReady || s.autoTradeAllowed).length,
    intelligenceCommits: signals.filter((s) => s.intelligenceCommit).length,
    avgQualityScore:
      signals.length > 0
        ? signals.reduce((a, s) => a + s.qualityScore, 0) / signals.length
        : null,
    lastHour: counts1h,
    signalWinRate: winStats.winRate,
    signalTracked: winStats.tracked,
    signalAvgChangePct: winStats.avgChangePct,
    paperWinRate: performance.winRate,
    paperTrades: performance.trades,
    paperPnlSol: performance.totalPnlSol,
    autoWinRate: autoPerf.winRate,
    autoTrades: autoPerf.trades,
    autoPnlSol: autoPerf.totalPnlSol,
    missedProfitSol: sumMissedProfitSol(signals),
    missedBuySignals: signals.filter((s) => s.missedProfitSol != null).length,
  };

  return NextResponse.json({ signals, summary, hours });
}
