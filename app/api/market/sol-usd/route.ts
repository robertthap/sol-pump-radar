import { NextResponse } from "next/server";
import { getSolUsd, solPriceCacheSnapshot } from "@/lib/market/sol-usd";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  await getSolUsd(); // refreshes both usd + aud in the shared cache
  const snap = solPriceCacheSnapshot();
  return NextResponse.json({ usd: snap.usd, aud: snap.aud, ageMs: snap.ageMs });
}
