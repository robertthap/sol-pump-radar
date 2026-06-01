import { NextResponse } from "next/server";
import { bootDb } from "@/lib/db/client";
import { fetchTracesForMint } from "@/lib/continuation/trace-store";
import { fetchContinuationDecisionTraces } from "@/lib/db/repos/decision-trace";
import { cached } from "@/lib/api/short-cache";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const mint = new URL(req.url).searchParams.get("mint");
  if (!mint) {
    return NextResponse.json({ error: "mint required" }, { status: 400 });
  }
  await bootDb();
  const engineTraces = await fetchTracesForMint(mint, 80);
  const decisionTraces = await fetchContinuationDecisionTraces(mint, 40);

  const traces = await cached(`trace:${mint}`, 4_000, async () =>
    [
      ...decisionTraces,
      ...engineTraces.map((t) => ({ ...t, stage: "engine_b_trace" })),
    ].sort((a, b) => b.timestamp - a.timestamp),
  );

  return NextResponse.json({ mint, traces });
}
