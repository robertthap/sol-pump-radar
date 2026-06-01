import { NextResponse } from "next/server";
import { bootDb } from "@/lib/db/client";
import { cached } from "@/lib/api/short-cache";
import { buildIntelligenceConsole } from "@/lib/intelligence/build-console";
import { withRoutePerf } from "@/lib/runtime/with-route-perf";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Mission control payload. ?lite=1 skips events/commits/rank series (faster). */
export const GET = withRoutePerf(async (req: Request) => {
  await bootDb();
  const lite = new URL(req.url).searchParams.get("lite") === "1";
  const cacheKey = lite ? "intel:console:lite:v1" : "intel:console:full:v3";
  const ttl = lite ? 8_000 : 15_000;
  const payload = await cached(cacheKey, ttl, () => buildIntelligenceConsole({ lite }));
  return NextResponse.json(payload);
});
