import { NextResponse } from "next/server";
import { bootDb } from "@/lib/db/client";
import { enrichUiPaperPositions } from "@/lib/paper/ui-positions-stats";
import { fetchUiPaperPositions } from "@/lib/paper/ui-positions";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  await bootDb();
  const url = new URL(req.url);
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 25)));
  const rows = await fetchUiPaperPositions(limit);
  const { positions, stats } = await enrichUiPaperPositions(rows);
  return NextResponse.json({ positions, stats });
}
