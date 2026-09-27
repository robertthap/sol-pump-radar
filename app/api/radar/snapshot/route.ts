import { NextResponse } from "next/server";
import { bootDb } from "@/lib/db/client";
import { cached } from "@/lib/api/short-cache";
import { parseRadarWindow } from "@/lib/radar/snapshot";
import { fetchRadarSnapshot } from "@/lib/radar/snapshot-query";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * The Coin Journey radar's only data source: GET /api/radar/snapshot?window=1m|5m|15m|1h.
 * The screen polls every 2 s; a short cache per window dedupes tabs. The hour window reads ~12x the rows, so it
 * is cached longer.
 */
export async function GET(req: Request) {
  await bootDb();
  const { key } = parseRadarWindow(new URL(req.url).searchParams.get("window"));
  try {
    const snapshot = await cached(`radar:${key}`, key === "1h" ? 5_000 : 1_500, () => fetchRadarSnapshot(key));
    return NextResponse.json(snapshot);
  } catch (err) {
    return NextResponse.json({ error: String(err instanceof Error ? err.message : err) }, { status: 503 });
  }
}
