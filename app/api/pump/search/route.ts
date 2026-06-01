import { NextResponse } from "next/server";
import { searchPumpFunCoins } from "@/lib/pump/fun-api";
import { cached } from "@/lib/api/short-cache";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const q = url.searchParams.get("q")?.trim() ?? "";
  const limit = Number(url.searchParams.get("limit") ?? 30);
  if (!q) return NextResponse.json({ coins: [] });

  try {
    const coins = await cached(`pump:search:${q}:${limit}`, 5_000, () =>
      searchPumpFunCoins(q, limit),
    );
    return NextResponse.json({ coins });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
