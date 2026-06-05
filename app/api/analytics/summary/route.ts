import { NextResponse } from "next/server";
import { bootDb } from "@/lib/db/client";
import {
  fetchEquityCurve,
  fetchDailyPnl,
  fetchTradeHistory,
  fetchPnlDistribution,
  fetchTopMintPerformance,
} from "@/lib/db/repos/analytics";
import { fetchOverall } from "@/lib/db/repos/performance";
import { getUiTradingMode } from "@/lib/db/repos/trading-mode";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  await bootDb();
  const url = new URL(req.url);
  const hours = Math.max(1, Math.min(24 * 365, Number(url.searchParams.get("hours") ?? 24)));
  const histLimit = Math.max(10, Math.min(1000, Number(url.searchParams.get("limit") ?? 200)));
  // Strict Demo/Real isolation: Demo users only ever see paper trades, Real users
  // only live. Enforced server-side so a client `source` param can't cross modes.
  const uiMode = await getUiTradingMode();
  const source: "paper" | "live" = uiMode === "real" ? "live" : "paper";

  const equityHours = hours;
  const equityBucket = hours <= 6 ? 2 : hours <= 24 ? 5 : hours <= 168 ? 30 : 120;
  const dailyDays = Math.min(60, Math.max(7, Math.ceil(hours / 24)));

  const [overall, equity, daily, trades, distribution, topMints] = await Promise.all([
    fetchOverall(),
    fetchEquityCurve(equityHours, equityBucket),
    fetchDailyPnl(dailyDays),
    fetchTradeHistory(hours, source, histLimit),
    fetchPnlDistribution(hours),
    fetchTopMintPerformance(hours, 8),
  ]);
  return NextResponse.json({
    windowHours: hours,
    source,
    mode: uiMode ?? "demo",
    overall,
    equity,
    daily,
    trades,
    distribution,
    topMints,
  });
}
