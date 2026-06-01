import { NextResponse } from "next/server";
import { bootDb } from "@/lib/db/client";
import { buildTradeBootstrap } from "@/lib/trade/bootstrap-data";
import { withRoutePerf } from "@/lib/runtime/with-route-perf";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** One round-trip for trade page: mode + auto status + log + opportunities. ?lite=1 skips log/opportunities. */
export const GET = withRoutePerf(async (req: Request) => {
  await bootDb();
  const lite = new URL(req.url).searchParams.get("lite") === "1";
  return NextResponse.json(await buildTradeBootstrap({ lite }));
});
