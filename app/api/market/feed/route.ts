import { NextResponse } from "next/server";
import { buildMarketFeed } from "@/lib/market/discovery";

export const dynamic = "force-dynamic";

/** GMGN-style market feed: discovery + SolPump analysis flags per coin. */
export async function GET() {
  try {
    const feed = await buildMarketFeed();
    return NextResponse.json(feed);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
