import { NextResponse } from "next/server";
import { bootDb } from "@/lib/db/client";
import {
  fetchActionPerformance,
  fetchExitReasonPerformance,
  fetchModuleBucketPerformance,
} from "@/lib/db/repos/outcomes";
import { listRecentChanges, readActiveOverrides } from "@/lib/db/repos/tuner";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  await bootDb();
  const url = new URL(req.url);
  const hours = Math.min(168, Math.max(1, Number(url.searchParams.get("hours") ?? 24)));
  const [actionPerf, moduleBuckets, exitReasons, overrides, changes] = await Promise.all([
    fetchActionPerformance(hours),
    fetchModuleBucketPerformance(hours),
    fetchExitReasonPerformance(hours),
    readActiveOverrides(),
    listRecentChanges(10),
  ]);
  return NextResponse.json({
    windowHours: hours,
    actionPerf,
    moduleBuckets,
    exitReasons,
    overrides,
    changes,
    autoTune: env().AUTO_TUNE,
    preset: env().RISK_PRESET,
  });
}
