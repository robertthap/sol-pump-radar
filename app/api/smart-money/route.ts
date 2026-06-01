import { NextResponse } from "next/server";
import { bootDb } from "@/lib/db/client";
import { fetchSmartMoney, fetchSmartMoneyTstatPctile } from "@/lib/db/repos/bots";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  await bootDb();
  const { searchParams } = new URL(req.url);
  const limit = Math.min(200, Number(searchParams.get("limit") ?? "50"));
  const minTstat = Number(searchParams.get("minTstat") ?? "1");
  const minClosed = Number(searchParams.get("minClosed") ?? "5");
  const excludeRingMembers = searchParams.get("excludeRings") === "1";
  const [rows, p25, p75] = await Promise.all([
    fetchSmartMoney({ limit, minTstat, minClosed, excludeRingMembers }),
    fetchSmartMoneyTstatPctile(0.25),
    fetchSmartMoneyTstatPctile(0.75),
  ]);
  return NextResponse.json({ rows, tstatP25: p25, tstatP75: p75, excludeRingMembers });
}
