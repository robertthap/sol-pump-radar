import { NextResponse } from "next/server";
import { bootDb } from "@/lib/db/client";
import { fetchTopActiveTokens } from "@/lib/db/repos/tokens";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  await bootDb();
  const url = new URL(req.url);
  const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit") ?? 10)));
  const rows = await fetchTopActiveTokens(limit);
  return NextResponse.json({ tokens: rows });
}
