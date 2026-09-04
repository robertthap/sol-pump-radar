import { NextResponse } from "next/server";
import { bootDb } from "@/lib/db/client";
import { cached } from "@/lib/api/short-cache";
import {
  fetchAutoPaperOverall,
  fetchTierOverall,
  fetchEntryReaction,
  fetchExecLatency,
  fetchDecisionToIntent,
} from "@/lib/db/repos/performance";

export const dynamic = "force-dynamic";

/**
 * Trade-page insights strip: 7d auto overall + strict-vs-relaxed split + latency.
 *
 * `reaction` is entry_age_seconds — a BLEND of token age and queue wait, kept
 * for comparability. `decisionToIntent` (ms) is the unambiguous
 * decision->execution queue latency; prefer it for any latency claim.
 */
export async function GET(req: Request) {
  await bootDb();
  const url = new URL(req.url);
  const hours = Math.min(168, Math.max(1, Number(url.searchParams.get("hours") ?? 168)));

  const data = await cached(`auto:session-insights:${hours}`, 15_000, async () => {
    const [overall, strict, relaxed, reaction, execLatency, decisionToIntent] = await Promise.all([
      fetchAutoPaperOverall(hours),
      fetchTierOverall("strict", hours),
      fetchTierOverall("relaxed", hours),
      fetchEntryReaction(hours),
      fetchExecLatency(hours),
      fetchDecisionToIntent(hours),
    ]);
    // reaction = seconds (token age at entry); execLatency = ms (intent -> fill).
    return { overall, strict, relaxed, reaction, execLatency, decisionToIntent };
  });

  return NextResponse.json({ source: "cache", ts: Date.now(), hours, ...data });
}
