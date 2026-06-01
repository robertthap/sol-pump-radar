import { NextResponse } from "next/server";
import { bootDb } from "@/lib/db/client";
import { readState } from "@/lib/circuit-breaker/state";
import { env } from "@/lib/env";
import { cached } from "@/lib/api/short-cache";

export const dynamic = "force-dynamic";

export async function GET() {
  await bootDb();
  const data = await cached("nav:status", 2_000, async () => {
    const cb = await readState();
    const e = env();
    return {
      cbState: cb.state,
      liveExecution: e.LIVE_EXECUTION,
      liveDryRun: e.LIVE_DRY_RUN,
      traderMode: e.TRADER_MODE,
      riskPreset: e.RISK_PRESET,
    };
  });
  return NextResponse.json(data);
}
