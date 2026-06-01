import { NextResponse } from "next/server";
import { runEngineBReplay } from "@/lib/continuation/replay-runner";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const mint = url.searchParams.get("mint");
  const hours = Number(url.searchParams.get("hours") ?? "24");
  const mints = mint ? [mint] : undefined;
  const result = await runEngineBReplay({ mints, timeWindowHours: hours });
  return NextResponse.json(result);
}
