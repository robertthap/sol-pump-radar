import { NextResponse } from "next/server";
import { bootDb } from "@/lib/db/client";
import { cached } from "@/lib/api/short-cache";
import { getPerformanceSnapshot } from "@/lib/workers/learner";
import {
  fetchOverall,
  fetchByExitReason,
  fetchByAction,
  fetchByGradBucket,
  fetchByRugBucket,
  fetchPerformanceBreakdown,
} from "@/lib/db/repos/performance";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  await bootDb();
  const url = new URL(req.url);
  const hours = Math.min(168, Math.max(1, Number(url.searchParams.get("hours") ?? 168)));
  const wantBreakdown = url.searchParams.get("breakdown") === "1";

  if (wantBreakdown) {
    const breakdown = await cached(`performance:breakdown:${hours}`, 15_000, () =>
      fetchPerformanceBreakdown(hours),
    );
    return NextResponse.json({ source: "cache", ts: Date.now(), breakdown });
  }

  const cachedSnap = getPerformanceSnapshot();
  if (cachedSnap && Date.now() - cachedSnap.ts < 35_000) {
    return NextResponse.json({ source: "cache", ...cachedSnap });
  }
  const [overall, byExitReason, byAction, byGradBucket, byRugBucket, breakdown] = await Promise.all([
    fetchOverall(),
    fetchByExitReason(),
    fetchByAction(),
    fetchByGradBucket(),
    fetchByRugBucket(),
    fetchPerformanceBreakdown(hours),
  ]);
  return NextResponse.json({
    source: "fresh",
    ts: Date.now(),
    overall,
    breakdown,
    byExitReason,
    byAction,
    byGradBucket,
    byRugBucket,
  });
}
