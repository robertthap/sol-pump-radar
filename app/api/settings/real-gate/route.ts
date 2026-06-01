import { NextResponse } from "next/server";
import { bootDb } from "@/lib/db/client";
import { fetchRealGateStats, getUiTradingMode } from "@/lib/db/repos/trading-mode";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Stats for Real-mode unlock checklist (soft gate — personal tool). */
export async function GET() {
  await bootDb();
  const [mode, stats] = await Promise.all([getUiTradingMode(), fetchRealGateStats()]);
  return NextResponse.json({ mode, ...stats });
}
