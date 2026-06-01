import { NextResponse } from "next/server";
import { bootDb } from "@/lib/db/client";
import { fetchClustersList } from "@/lib/db/repos/clusters";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  await bootDb();
  const { searchParams } = new URL(req.url);
  const limit = Math.min(100, Number(searchParams.get("limit") ?? "20"));
  const kindFilter = searchParams.get("kind");

  const clusters = await fetchClustersList({ limit, kind: kindFilter });
  return NextResponse.json({ clusters });
}
