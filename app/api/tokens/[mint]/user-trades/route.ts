import { NextResponse } from "next/server";
import { bootDb } from "@/lib/db/client";
import { fetchUserTradesForMint } from "@/lib/chart/data/userTrades";
import { getActiveSession } from "@/lib/db/repos/auto-sessions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ mint: string }> },
) {
  const { mint } = await params;
  if (!mint || mint.length < 32) {
    return NextResponse.json({ error: "invalid_mint" }, { status: 400 });
  }
  const url = new URL(req.url);
  const sessionId = url.searchParams.get("sessionId");

  await bootDb();
  try {
    let sid = sessionId;
    if (!sid) {
      const active = await getActiveSession();
      sid = active?.id?.toString() ?? null;
    }
    const trades = await fetchUserTradesForMint(mint, sid);
    return NextResponse.json({ trades });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
