import { NextResponse } from "next/server";
import { fetchTrenchesFeed } from "@/lib/pump/fun-api";
import { cached } from "@/lib/api/short-cache";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const feed = await cached("pump:trenches", 6_000, () => fetchTrenchesFeed());
    return NextResponse.json(feed);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
