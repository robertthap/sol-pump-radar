import { NextResponse } from "next/server";
import { bootDb } from "@/lib/db/client";
import {
  fetchIntelligenceCommits,
  fetchIntelligenceFeedStats,
} from "@/lib/db/repos/intelligence-feed";
import { cached } from "@/lib/api/short-cache";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  await bootDb();
  const url = new URL(req.url);
  const limit = Number(url.searchParams.get("limit") ?? 40);
  const mint = url.searchParams.get("mint")?.trim() || null;
  const cacheKey = `intel:feed:${limit}:${mint ?? ""}`;

  const { commits, stats } = await cached(cacheKey, 3_000, async () => {
    const [c, s] = await Promise.all([
      fetchIntelligenceCommits(limit, mint),
      fetchIntelligenceFeedStats(),
    ]);
    return { commits: c, stats: s };
  });

  return NextResponse.json({ commits, stats });
}
