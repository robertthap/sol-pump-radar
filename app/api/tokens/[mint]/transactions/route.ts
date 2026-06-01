import { NextResponse } from "next/server";
import { bootDb } from "@/lib/db/client";
import { fetchMintTradeEvents } from "@/lib/db/repos/events";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  req: Request,
  ctx: { params: Promise<{ mint: string }> },
) {
  await bootDb();
  const { mint } = await ctx.params;
  const url = new URL(req.url);
  const limit = Math.min(200, Math.max(10, Number(url.searchParams.get("limit") ?? 80)));

  const txs = await fetchMintTradeEvents(mint, limit);
  return NextResponse.json({ mint, txs });
}
