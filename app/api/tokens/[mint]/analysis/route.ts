import { NextResponse } from "next/server";
import { bootDb } from "@/lib/db/client";
import { fetchTokenAnalysis } from "@/lib/api/token-analysis";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ mint: string }> },
) {
  const { mint } = await params;
  if (!mint || mint.length < 32) {
    return NextResponse.json({ error: "invalid_mint" }, { status: 400 });
  }

  await bootDb();

  try {
    const data = await fetchTokenAnalysis(mint);
    if (!data.pump && !data.symbol) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
