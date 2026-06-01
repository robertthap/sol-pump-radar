import { NextResponse } from "next/server";
import { bootDb } from "@/lib/db/client";
import { cached } from "@/lib/api/short-cache";
import { fetchModeLiteSnapshot } from "@/lib/settings/mode-lite-snapshot";
import { withRoutePerf } from "@/lib/runtime/with-route-perf";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Lightweight mode poll for header — skips per-position lateral joins. */
export const GET = withRoutePerf(async () => {
  await bootDb();
  return NextResponse.json(
    await cached("settings:mode-lite", 12_000, () => fetchModeLiteSnapshot()),
  );
});
