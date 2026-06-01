import { NextResponse } from "next/server";
import { bootDb } from "@/lib/db/client";
import { cached } from "@/lib/api/short-cache";
import { autoDemoRelaxEnabled } from "@/lib/env";
import { countPendingBuyDecisions } from "@/lib/db/repos/paper-trades";
import {
  getActiveSession,
  getLatestSession,
  fetchSessionActivityLog,
} from "@/lib/db/repos/auto-sessions";
import { withRoutePerf } from "@/lib/runtime/with-route-perf";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = withRoutePerf(async (req: Request) => {
  await bootDb();
  const url = new URL(req.url);
  const since = url.searchParams.get("since") ?? "";
  const limit = Number(url.searchParams.get("limit") ?? 80);

  const active = await getActiveSession();
  const session = active ?? (await getLatestSession());
  if (!session) {
    return NextResponse.json({ active: false, sessionId: null, entries: [] });
  }

  const cacheKey = `auto:log:${session.id}:${since}:${limit}`;
  const payload = await cached(cacheKey, 4_000, async () => {
    const entries = await fetchSessionActivityLog(session.id, {
      since: since || undefined,
      limit,
    });
    const pendingBuyCount = active
      ? await countPendingBuyDecisions(90, { relaxAutoGate: autoDemoRelaxEnabled() })
      : 0;
    return {
      active: !!active,
      sessionId: session.id,
      entries,
      pendingBuyCount,
      tradesOpened: session.stats?.tradesOpened ?? 0,
    };
  });

  return NextResponse.json(payload);
});
