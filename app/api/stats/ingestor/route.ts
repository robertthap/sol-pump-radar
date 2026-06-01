import { NextResponse } from "next/server";
import { bootDb } from "@/lib/db/client";
import { getIngestorStats, sigsLastMinute } from "@/lib/rpc/stats";
import { countSinceBoot } from "@/lib/db/repos/events";
import { cached } from "@/lib/api/short-cache";

export const dynamic = "force-dynamic";

export async function GET() {
  await bootDb();
  const s = getIngestorStats();
  const counts = await cached("counts:boot", 5_000, () => countSinceBoot());
  return NextResponse.json({
    connState: s.connState,
    endpoint: s.endpoint,
    connectedAt: s.connectedAt,
    lastMessageAt: s.lastMessageAt,
    reconnects: s.reconnects,
    signaturesSeen: s.signaturesSeen,
    eventsParsed: s.eventsParsed,
    eventsInserted: s.eventsInserted,
    decodeErrors: s.decodeErrors,
    lastError: s.lastError,
    sigsLastMinute: sigsLastMinute(),
    counts,
    serverNow: Date.now(),
  });
}
