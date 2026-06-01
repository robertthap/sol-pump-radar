import { NextResponse } from "next/server";
import { bootDb } from "@/lib/db/client";
import { fetchManyMintFlags } from "@/lib/db/repos/bots";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  await bootDb();
  const { searchParams } = new URL(req.url);
  const mintsParam = searchParams.get("mints");
  if (!mintsParam) return NextResponse.json({ flags: {} });
  const mints = mintsParam.split(",").filter((m) => m.length >= 32 && m.length <= 64);
  if (mints.length === 0) return NextResponse.json({ flags: {} });
  const map = await fetchManyMintFlags(mints);
  const out: Record<string, unknown> = {};
  for (const [k, v] of map) out[k] = v;
  return NextResponse.json({ flags: out });
}
