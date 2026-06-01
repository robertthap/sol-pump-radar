import { NextResponse } from "next/server";
import { bootDb } from "@/lib/db/client";
import { fetchMintSignalMarkers } from "@/lib/db/repos/decisions";
import { fetchMintOHLCV } from "@/lib/db/repos/events";
import { cached } from "@/lib/api/short-cache";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  req: Request,
  ctx: { params: Promise<{ mint: string }> },
) {
  await bootDb();
  const { mint } = await ctx.params;
  const url = new URL(req.url);
  const hours = Math.min(48, Math.max(1, Number(url.searchParams.get("hours") ?? 6)));

  const payload = await cached(`chart:${mint}:${hours}`, 4_000, async () => {
    const candles = await fetchMintOHLCV(mint, hours);
    const signals = await fetchMintSignalMarkers(mint, hours);
    return { mint, hours, candles, signals };
  });

  return NextResponse.json(payload);
}
