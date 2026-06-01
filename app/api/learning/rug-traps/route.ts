import { NextResponse } from "next/server";
import { bootDb } from "@/lib/db/client";
import { fetchRugPerformance24h, fetchRugTrapExamples } from "@/lib/db/repos/rug-labels";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  await bootDb();
  const [performance, examples] = await Promise.all([
    fetchRugPerformance24h(),
    fetchRugTrapExamples(15),
  ]);
  return NextResponse.json({ performance, examples });
}
