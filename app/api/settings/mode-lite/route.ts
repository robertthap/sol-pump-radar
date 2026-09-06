import { NextResponse } from "next/server";
import { bootDb } from "@/lib/db/client";
import { cached, invalidateCache } from "@/lib/api/short-cache";
import { fetchModeLiteSnapshot } from "@/lib/settings/mode-lite-snapshot";
import { withRoutePerf } from "@/lib/runtime/with-route-perf";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Lightweight mode poll for header — skips per-position lateral joins.
 *
 * `?fresh=1` bypasses AND clears the 12s cache. Needed because a demo reset is
 * performed by the WORKER ~1.5s after the request is queued: the PUT route can
 * only invalidate at queue time, and any poll in that window (the ticker polls
 * every second and shares this key) re-caches PRE-reset data for a further 12s.
 * A caller that has waited for DEMO_RESET_COMPLETED knows the data changed and
 * must be able to say so.
 */
export const GET = withRoutePerf(async (req: Request) => {
  await bootDb();
  const fresh = new URL(req.url).searchParams.get("fresh") === "1";
  if (fresh) {
    invalidateCache("settings:mode-lite");
    // The ticker embeds this same snapshot, so its cache must go too.
    invalidateCache("ticker");
  }
  return NextResponse.json(
    await cached("settings:mode-lite", 12_000, () => fetchModeLiteSnapshot()),
  );
});
