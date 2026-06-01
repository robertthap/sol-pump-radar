import { NextResponse } from "next/server";
import { fetchPumpFunCoin } from "@/lib/pump/fun-api";
import { cached } from "@/lib/api/short-cache";

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
  try {
    const coin = await cached(`pump:coin:${mint}`, 1_500, () => fetchPumpFunCoin(mint));
    if (!coin) {
      return NextResponse.json({ error: "not_a_pump_fun_coin" }, { status: 404 });
    }
    return NextResponse.json(coin);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
