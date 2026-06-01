import { NextResponse } from "next/server";
import { bootDb } from "@/lib/db/client";
import { fetchTokenSnapshot } from "@/lib/db/repos/token-snapshot";
import { cached } from "@/lib/api/short-cache";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ mint: string }> },
) {
  await bootDb();
  const { mint } = await params;
  if (!mint || mint.length < 32) {
    return NextResponse.json({ error: "invalid_mint" }, { status: 400 });
  }
  const payload = await cached(`snap:${mint}`, 3_000, () => fetchTokenSnapshot(mint));
  return NextResponse.json(payload);
}
