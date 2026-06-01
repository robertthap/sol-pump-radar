import { NextResponse } from "next/server";
import { bootDb } from "@/lib/db/client";
import { fetchLiveCreatesEnriched } from "@/lib/db/repos/live-creates";
import { fetchRugPerformance24h } from "@/lib/db/repos/rug-labels";
import { countSinceBoot } from "@/lib/db/repos/events";
import { getIngestorStats } from "@/lib/rpc/stats";
import { cached } from "@/lib/api/short-cache";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  await bootDb();
  const url = new URL(req.url);
  const limit = Number(url.searchParams.get("limit") ?? 60);
  const hours = Number(url.searchParams.get("hours") ?? 24);
  const includeAnalysis = url.searchParams.get("analysis") !== "0";
  const cacheKey = `creates:${hours}:${limit}:${includeAnalysis}`;

  const payload = await cached(cacheKey, 3_000, async () => {
    const [creates, counts, ingestor] = await Promise.all([
      fetchLiveCreatesEnriched({ limit, hours }),
      cached("counts:boot", 5_000, () => countSinceBoot()),
      Promise.resolve(getIngestorStats()),
    ]);
    const analysis = includeAnalysis
      ? await cached("rug:perf24h", 30_000, () => fetchRugPerformance24h())
      : null;
    return {
      creates,
      ingestor: {
        connState: ingestor.connState,
        eventsInserted: ingestor.eventsInserted,
        lastError: ingestor.lastError,
      },
      counts,
      analysis,
    };
  });

  return NextResponse.json(payload);
}
