import { NextResponse } from "next/server";
import { fetchPumpFunCoins } from "@/lib/pump/fun-api";
import { cached } from "@/lib/api/short-cache";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const limit = Number(url.searchParams.get("limit") ?? 50);
  const offset = Number(url.searchParams.get("offset") ?? 0);
  const sort = (url.searchParams.get("sort") ?? "last_trade_timestamp") as
    | "last_trade_timestamp"
    | "created_timestamp"
    | "market_cap";
  const order = (url.searchParams.get("order") ?? "DESC") as "ASC" | "DESC";
  const cacheKey = `pump:coins:${sort}:${order}:${offset}:${limit}`;

  try {
    const coins = await cached(cacheKey, 5_000, () =>
      fetchPumpFunCoins({ limit, offset, sort, order }),
    );
    return NextResponse.json({ coins });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
