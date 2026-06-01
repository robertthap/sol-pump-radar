import { NextResponse } from "next/server";
import { resolveDexEmbed } from "@/lib/dex/embed";

export const dynamic = "force-dynamic";

/** Resolve DexScreener embed URL for a mint. */
export async function GET(req: Request) {
  const mint = new URL(req.url).searchParams.get("mint")?.trim();
  if (!mint) {
    return NextResponse.json({ error: "mint required" }, { status: 400 });
  }

  const config = await resolveDexEmbed(mint);
  if (!config) {
    return NextResponse.json({ error: "no DexScreener pair for mint yet" }, { status: 404 });
  }

  return NextResponse.json(config);
}
