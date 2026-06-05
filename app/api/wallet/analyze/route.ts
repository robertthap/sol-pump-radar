import { NextResponse } from "next/server";
import { bootDb } from "@/lib/db/client";
import { fetchWalletProfile } from "@/lib/db/repos/bots";
import { analyzeCopyTradeSafety } from "@/lib/wallet/copy-trade-safety";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Analyze a pasted wallet address for copy-trade safety from our closed-trade data. */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const wallet = (searchParams.get("wallet") ?? "").trim();
  if (!wallet || !BASE58.test(wallet)) {
    return NextResponse.json({ error: "invalid_wallet" }, { status: 400 });
  }
  await bootDb();
  try {
    const profile = await fetchWalletProfile(wallet);
    const analysis = analyzeCopyTradeSafety(profile);
    return NextResponse.json({ wallet, profile, analysis });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
