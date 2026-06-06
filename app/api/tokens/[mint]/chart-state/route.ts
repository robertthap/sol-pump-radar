import { NextResponse } from "next/server";
import { bootDb } from "@/lib/db/client";
import type { ChartTimeframe } from "@/lib/chart/types";
import { buildSyncSnapshot } from "@/lib/chart/runtime/chartRuntime";
import { fetchStreamState } from "@/lib/chart/data/tradeStore";

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

  await bootDb();
  try {
    const snapshot = await buildSyncSnapshot(mint, tf);
    const stream = await fetchStreamState(mint);
    return NextResponse.json({
      ...snapshot,
      lastSeq: stream?.lastSeq ?? 0,
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
