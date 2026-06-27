import { NextResponse } from "next/server";
import { bootDb } from "@/lib/db/client";
import { DEFAULT_CHART_TF } from "@/lib/chart/constants";
import { parseChartTimeframe } from "@/lib/chart/timeframes";
import { markChartActive } from "@/lib/chart/data/chartActiveMints";
import { buildSyncSnapshot } from "@/lib/chart/runtime/chartRuntime";
import { fetchStreamState } from "@/lib/chart/data/tradeStore";
import { cached } from "@/lib/api/short-cache";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// T2.3 — buildSyncSnapshot stitches curve+DEX + on-chain overlay + graduation
// resolution on every call. A short TTL coalesces rapid/concurrent polls without
// adding meaningful staleness: the on-chain tail is ~2s fresh and Gecko is ~20s
// cached, so 2s here is below the underlying data's own refresh cadence.
const CHART_STATE_TTL_MS = 2000;

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

  await bootDb();
  markChartActive(mint);
  try {
    const payload = await cached(`chart-state:${mint}:${tf}`, CHART_STATE_TTL_MS, async () => {
      const snapshot = await buildSyncSnapshot(mint, tf);
      const stream = await fetchStreamState(mint);
      return { ...snapshot, lastSeq: stream?.lastSeq ?? 0 };
    });
    return NextResponse.json(payload);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
