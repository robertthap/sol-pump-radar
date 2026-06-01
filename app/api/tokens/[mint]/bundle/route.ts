import { NextResponse } from "next/server";
import { bootDb } from "@/lib/db/client";
import { fetchTokenBundle, fetchTokenBundleLite } from "@/lib/api/token-bundle";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ mint: string }> },
) {
  const { mint } = await params;
  if (!mint || mint.length < 32) {
    return NextResponse.json({ error: "invalid_mint" }, { status: 400 });
  }
  const url = new URL(req.url);
  const hours = Math.min(48, Math.max(1, Number(url.searchParams.get("hours") ?? 6)));
  const lite = url.searchParams.get("lite") === "1";

  await bootDb();

  try {
    const bundle = lite
      ? await fetchTokenBundleLite(mint, hours)
      : await fetchTokenBundle(mint, hours);
    if (!bundle.analysis.pump && !bundle.analysis.symbol && !bundle.analysis.vSol) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return NextResponse.json(bundle);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
