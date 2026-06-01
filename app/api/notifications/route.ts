import { NextResponse } from "next/server";
import { bootDb } from "@/lib/db/client";
import { fetchRecentNotifications } from "@/lib/notify";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  await bootDb();
  const { searchParams } = new URL(req.url);
  const limit = Math.min(200, Number(searchParams.get("limit") ?? "50"));
  const rows = await fetchRecentNotifications(limit);
  return NextResponse.json({
    rows: rows.map((r) => ({
      id: r.id.toString(),
      ts: r.ts.toISOString(),
      kind: r.kind,
      title: r.title,
      body: r.body,
      mint: r.mint,
      severity: r.severity,
      extra: r.extra,
    })),
  });
}
