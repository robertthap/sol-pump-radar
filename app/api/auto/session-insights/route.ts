import { NextResponse } from "next/server";
import { bootDb } from "@/lib/db/client";
import { cached } from "@/lib/api/short-cache";
import {
  fetchAutoPaperOverall,
  fetchTierOverall,
  fetchEntryReaction,
} from "@/lib/db/repos/performance";

export const dynamic = "force-dynamic";

/** Trade-page insights strip: 7d auto overall + strict-vs-relaxed split + reaction time. */
export async function GET(req: Request) {
  await bootDb();
  const url = new URL(req.url);
  const hours = Math.min(168, Math.max(1, Number(url.searchParams.get("hours") ?? 168)));

  const data = await cached(`auto:session-insights:${hours}`, 15_000, async () => {
    const [overall, strict, relaxed, reaction] = await Promise.all([
      fetchAutoPaperOverall(hours),
      fetchTierOverall("strict", hours),
      fetchTierOverall("relaxed", hours),
      fetchEntryReaction(hours),
    ]);
    return { overall, strict, relaxed, reaction };
  });

  return NextResponse.json({ source: "cache", ts: Date.now(), hours, ...data });
}
