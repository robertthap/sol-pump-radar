import { NextResponse } from "next/server";
import { getSolUsd, solPriceCacheSnapshot } from "@/lib/market/sol-usd";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  await getSolUsd(); // refreshes both usd + aud in the shared cache
  const snap = solPriceCacheSnapshot();
  // M01: ship the verdict with the numbers so no client can render the
  // never-fetched fallback rate as a live one.
  return NextResponse.json({
    usd: snap.usd, aud: snap.aud, ageMs: snap.ageMs,
    stale: snap.stale, fallback: snap.usingFallback,
  });
}
