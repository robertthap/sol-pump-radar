import { NextResponse } from "next/server";
import { bootDb } from "@/lib/db/client";
import {
  fetchContinuationUniverseStats,
  fetchTopContinuationCandidates,
} from "@/lib/db/repos/continuation-candidates";
import { fetchIntelligenceFeedStats } from "@/lib/db/repos/intelligence-feed";
import { fetchEngineBTraceStageCounts } from "@/lib/db/repos/decision-trace";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  await bootDb();
  const [stats, intelligence, topCandidates, traceStagesLast1h] = await Promise.all([
    fetchContinuationUniverseStats(),
    fetchIntelligenceFeedStats(),
    fetchTopContinuationCandidates(15),
    fetchEngineBTraceStageCounts(1, 12),
  ]);

  return NextResponse.json({
    stats: stats ?? { total: 0, alert_ready: 0, last_updated: null },
    intelligence: intelligence ?? {
      commits_last_hour: 0,
      auto_eligible_last_hour: 0,
      engine_a_count: 0,
      engine_b_count: 0,
    },
    topCandidates,
    traceStagesLast1h,
  });
}
