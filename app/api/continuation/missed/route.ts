import { NextResponse } from "next/server";
import { bootDb } from "@/lib/db/client";
import { buildMissedWinnerReport } from "@/lib/continuation/missed-report";
import { cached } from "@/lib/api/short-cache";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  await bootDb();
  const mintsParam = new URL(req.url).searchParams.get("mints");
  const mints = mintsParam ? mintsParam.split(",").map((s) => s.trim()) : undefined;
  const cacheKey = `continuation:missed:${mints?.join(",") ?? "default"}`;
  const report = await cached(cacheKey, 120_000, () => buildMissedWinnerReport(mints));
  return NextResponse.json(report);
}
