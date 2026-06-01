import { NextResponse } from "next/server";
import { bootDb } from "@/lib/db/client";
import { fetchRugStats, fetchRugPerformance24h } from "@/lib/db/repos/rug-labels";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  await bootDb();
  const url = new URL(req.url);
  const window = url.searchParams.get("window");
  const stats = await fetchRugStats();
  if (window === "24h") {
    const performance = await fetchRugPerformance24h();
    return NextResponse.json({ stats, performance });
  }
  return NextResponse.json({ stats });
}
