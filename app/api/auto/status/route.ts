import { NextResponse } from "next/server";
import { bootDb } from "@/lib/db/client";
import { fetchAutoStatusSnapshot } from "@/lib/auto/status-snapshot";
import { cached } from "@/lib/api/short-cache";
import { withRoutePerf } from "@/lib/runtime/with-route-perf";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = withRoutePerf(async (req: Request) => {
  await bootDb();
  const includeTrades = new URL(req.url).searchParams.get("trades") === "1";
  return NextResponse.json(
    await cached(`auto:status:${includeTrades ? "t" : "lite"}`, 6_000, () =>
      fetchAutoStatusSnapshot(includeTrades),
    ),
  );
});
