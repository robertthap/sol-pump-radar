import { NextResponse } from "next/server";
import { runEngineBCompare } from "@/lib/continuation/engine-b-compare";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const evalOnly = url.searchParams.get("evalOnly") === "1";
  const mintsParam = url.searchParams.get("mints");
  const mints = mintsParam ? mintsParam.split(",").map((s) => s.trim()) : undefined;

  const report = await runEngineBCompare({
    mints,
    includeDexTop50: !evalOnly,
  });

  return NextResponse.json(report);
}
