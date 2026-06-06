import { NextResponse } from "next/server";
import { bootDb } from "@/lib/db/client";
import type { ChartTimeframe } from "@/lib/chart/types";
import { CANDLE_PAGE_SIZE } from "@/lib/chart/constants";
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
  const tf = (url.searchParams.get("tf") ?? "1m") as ChartTimeframe;
  const beforeId = url.searchParams.get("beforeId") ?? undefined;
  const limit = Math.min(
    CANDLE_PAGE_SIZE,
    Math.max(50, Number(url.searchParams.get("limit") ?? CANDLE_PAGE_SIZE)),
  );

  await bootDb();
  try {
    const { candles, oldestTradeId } = await buildCandlesFromDb(mint, tf, { beforeId, limit });
    return NextResponse.json({
      mint,
      tf,
      candles,
      oldestTradeId,
      hasMore: candles.length >= limit,
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
