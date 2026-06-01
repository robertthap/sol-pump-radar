import { NextResponse } from "next/server";
import { bootDb } from "@/lib/db/client";
import { fetchClosedPaperHistory } from "@/lib/paper/history";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  await bootDb();
  const url = new URL(req.url);
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? 50)));
  const sessionId = url.searchParams.get("sessionId");

  const closed = await fetchClosedPaperHistory({ limit, sessionId });
  return NextResponse.json({ closed });
}
