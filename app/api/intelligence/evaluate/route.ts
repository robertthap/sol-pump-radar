import { NextResponse } from "next/server";
import { evaluateMintIntelligence, evaluateUniverseIntelligence } from "@/lib/intelligence";
import type { IntelligenceInputSnapshot } from "@/lib/intelligence/types";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const inputs = (Array.isArray(body?.mints) ? body.mints : [body]) as IntelligenceInputSnapshot[];

    if (!inputs.length || !inputs[0]?.mint) {
      return NextResponse.json({ error: "mint required" }, { status: 400 });
    }

    const results =
      inputs.length === 1
        ? [evaluateMintIntelligence(inputs[0]!, body?.context ?? {})]
        : evaluateUniverseIntelligence(inputs, {
            ops_healthy: body?.ops_healthy ?? true,
          });

    return NextResponse.json({ results });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
