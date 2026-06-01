import { NextResponse } from "next/server";
import { bootDb } from "@/lib/db/client";
import {
  fetchRecentEvents,
  fetchRecentCreates,
  type EventKindFilter,
} from "@/lib/db/repos/events";

export const dynamic = "force-dynamic";

const VALID_KINDS: EventKindFilter[] = ["create", "trade", "buy", "sell", "migrate", "all"];

export async function GET(req: Request) {
  await bootDb();
  const url = new URL(req.url);
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? 50)));
  const rawKind = (url.searchParams.get("kind") ?? "all").toLowerCase();
  const kind = (VALID_KINDS as string[]).includes(rawKind)
    ? (rawKind as EventKindFilter)
    : "all";
  if (kind === "create") {
    const events = await fetchRecentCreates(limit);
    return NextResponse.json({ events });
  }
  const events = await fetchRecentEvents(limit, kind);
  return NextResponse.json({ events });
}
