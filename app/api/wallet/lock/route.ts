import { NextResponse } from "next/server";
import { bootDb } from "@/lib/db/client";
import { lock } from "@/lib/wallet/session";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST() {
  await bootDb();
  if (env().WEB_WALLET_SESSION !== "on") {
    return NextResponse.json({ error: "web_wallet_session_disabled" }, { status: 409 });
  }
  lock();
  return NextResponse.json({ ok: true });
}
