import { NextResponse } from "next/server";
import { bootDb } from "@/lib/db/client";
import { fetchIntelligenceCommits } from "@/lib/db/repos/intelligence-feed";
import { fuseEngineIntelligence } from "@/lib/intelligence/engine-fusion";
import {
  loadCommitInputBundle,
  prepareMintEval,
} from "@/lib/intelligence/commit-input";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const mint = new URL(req.url).searchParams.get("mint")?.trim();
  if (!mint) {
    return NextResponse.json({ error: "mint required" }, { status: 400 });
  }

  await bootDb();
  const preview = new URL(req.url).searchParams.get("preview") === "1";

  const [commits, previewResult] = await Promise.all([
    fetchIntelligenceCommits(30, mint),
    preview ? loadPreview(mint) : Promise.resolve(null),
  ]);

  return NextResponse.json({
    mint,
    commits,
    preview: previewResult,
  });
}

async function loadPreview(mint: string) {
  try {
    const bundle = await loadCommitInputBundle();
    const prep = await prepareMintEval(bundle, mint);
    if (!prep) {
      return { in_universe: false, output: null, fusion: null };
    }

    const ctx = {
      cross_mint: prep.cross_mint,
      trigger_events: prep.trigger_events,
      prior_state: prep.prior_state,
      risk_flags: prep.risk_flags,
      in_universe: true,
      normalized: true,
      ops_healthy: true,
      universe_size: bundle.mints.length,
    };

    const { output, fusion } = fuseEngineIntelligence(prep.input, ctx);
    return {
      in_universe: true,
      output,
      fusion: {
        engine: fusion.winner,
        reason: fusion.fusionReason,
      },
      loaded_at: bundle.loadedAt,
    };
  } catch (e) {
    return { in_universe: false, error: String(e), output: null, fusion: null };
  }
}
