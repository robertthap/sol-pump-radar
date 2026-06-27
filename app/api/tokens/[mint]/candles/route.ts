import { NextResponse } from "next/server";
import { bootDb } from "@/lib/db/client";
import { CANDLE_PAGE_SIZE, DEFAULT_CHART_TF } from "@/lib/chart/constants";
import { parseChartTimeframe } from "@/lib/chart/timeframes";
import { markChartActive } from "@/lib/chart/data/chartActiveMints";
import { buildCandlesFromDb } from "@/lib/chart/runtime/chartRuntime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ mint: string }> },
) {
  const { mint } = await params;
  if (!mint || mint.length < 32) {
    return NextResponse.json({ error: "invalid_mint" }, { status: 400 });
  }
  const url = new URL(req.url);
  const tf = parseChartTimeframe(url.searchParams.get("tf") ?? DEFAULT_CHART_TF);
  const beforeId = url.searchParams.get("beforeId") ?? undefined;
  const limit = Math.min(
    CANDLE_PAGE_SIZE,
    Math.max(50, Number(url.searchParams.get("limit") ?? CANDLE_PAGE_SIZE)),
  );

  await bootDb();
  markChartActive(mint);
  try {
    const { candles, oldestTradeId, hasMoreEvents } = await buildCandlesFromDb(mint, tf, { beforeId, limit });
    return NextResponse.json({
      mint,
      tf,
      candles,
      oldestTradeId,
      hasMore: hasMoreEvents,
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
