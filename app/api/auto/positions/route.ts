import { NextResponse } from "next/server";
import { bootDb } from "@/lib/db/client";
import { cached } from "@/lib/api/short-cache";
import { fetchAutoSessionPositionsSnapshot } from "@/lib/auto/session-positions";
import { withRoutePerf } from "@/lib/runtime/with-route-perf";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = withRoutePerf(async (req: Request) => {
  await bootDb();
  const url = new URL(req.url);
  const limit = Number(url.searchParams.get("limit") ?? 30);
  const live = url.searchParams.get("live") === "1";
  if (live) {
    const payload = await fetchAutoSessionPositionsSnapshot(limit);
    return NextResponse.json(payload);
  }
  const payload = await cached(`auto:positions:${limit}`, 2_500, () =>
    fetchAutoSessionPositionsSnapshot(limit),
  );
  return NextResponse.json(payload);
});
