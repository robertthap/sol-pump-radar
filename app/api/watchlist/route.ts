import { NextResponse } from "next/server";
import { bootDb } from "@/lib/db/client";
import { fetchLatestDecisions, fetchDecisionCounts } from "@/lib/db/repos/decisions";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  await bootDb();
  const url = new URL(req.url);
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 30)));
  const includeAvoid = url.searchParams.get("includeAvoid") === "1";
  const [decisions, counts] = await Promise.all([
    fetchLatestDecisions(limit, { includeAvoid }),
    fetchDecisionCounts(),
  ]);
  return NextResponse.json({ decisions, counts });
}
