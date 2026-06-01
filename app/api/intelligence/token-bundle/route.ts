import { NextResponse } from "next/server";
import { bootDb } from "@/lib/db/client";
import { fetchIntelligenceCommits } from "@/lib/db/repos/intelligence-feed";
import { fetchContinuationCandidateByMint } from "@/lib/db/repos/continuation-candidates";
import { fetchTracesForMint } from "@/lib/continuation/trace-store";
import { cached } from "@/lib/api/short-cache";
import { timedQuery } from "@/lib/db/query-metrics";
import { prepareMintEval } from "@/lib/intelligence/commit-input";
import { getCommitInputBundle } from "@/lib/intelligence/bundle-cache";
import { fuseEngineIntelligence } from "@/lib/intelligence/engine-fusion";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const mint = url.searchParams.get("mint")?.trim();
  const includePreview = url.searchParams.get("preview") === "1";
  if (!mint) {
    return NextResponse.json({ error: "mint required" }, { status: 400 });
  }

  await bootDb();
  const key = `intel:bundle:${mint}:p${includePreview ? "1" : "0"}`;

  const payload = await cached(key, 6_000, async () => {
    const [commits, traces, candidate] = await Promise.all([
      timedQuery("token-bundle:commits", () => fetchIntelligenceCommits(20, mint)),
      timedQuery("token-bundle:traces", () => fetchTracesForMint(mint, 40)),
      timedQuery("token-bundle:candidate", () => fetchContinuationCandidateByMint(mint)),
    ]);

    let preview: unknown = null;
    if (includePreview) {
      try {
        const bundle = await getCommitInputBundle();
        const prep = await prepareMintEval(bundle, mint);
        if (prep) {
          const { output, fusion } = fuseEngineIntelligence(prep.input, {
            cross_mint: prep.cross_mint,
            trigger_events: prep.trigger_events,
            prior_state: prep.prior_state,
            risk_flags: prep.risk_flags,
            in_universe: true,
            normalized: true,
            ops_healthy: true,
            universe_size: bundle.mints.length,
          });
          preview = {
            in_universe: true,
            output,
            fusion: { engine: fusion.winner, reason: fusion.fusionReason },
          };
        } else {
          preview = {
            in_universe: false,
            miss_type: "NOT_IN_UNIVERSE",
            detail: "Mint not in commit bundle — not scored this tick.",
          };
        }
      } catch (e) {
        preview = { in_universe: false, error: String(e) };
      }
    }

    return { mint, commits, traces, candidate, preview, ts: Date.now() };
  });

  return NextResponse.json(payload);
}
