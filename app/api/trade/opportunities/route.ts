import { NextResponse } from "next/server";
import { bootDb } from "@/lib/db/client";
import { cached } from "@/lib/api/short-cache";
import {
  fetchTradeOpportunitiesFull,
  fetchTradeOpportunitiesLite,
} from "@/lib/trade/opportunities-lite";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  await bootDb();
  const url = new URL(req.url);
  const limit = Math.min(60, Math.max(5, Number(url.searchParams.get("limit") ?? 24)));
  const minConf = Number(url.searchParams.get("minConf") ?? 0.56);
  const lite = url.searchParams.get("lite") !== "0";
  const cacheKey = `opps:${lite ? "lite" : "full"}:${limit}:${minConf}`;

  const opportunities = await cached(cacheKey, lite ? 10_000 : 5_000, () =>
    lite ? fetchTradeOpportunitiesLite(limit, minConf) : fetchTradeOpportunitiesFull(limit, minConf),
  );

  return NextResponse.json({ opportunities });
}
