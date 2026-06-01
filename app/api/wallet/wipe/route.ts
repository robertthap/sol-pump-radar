import { NextRequest, NextResponse } from "next/server";
import { bootDb } from "@/lib/db/client";
import { lock } from "@/lib/wallet/session";
import { deleteWallet } from "@/lib/wallet/storage";
import { logger } from "@/lib/log";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const log = logger("api:wallet:wipe");

export async function POST(req: NextRequest) {
  await bootDb();
  if (env().WEB_WALLET_SESSION !== "on") {
    return NextResponse.json({ error: "web_wallet_session_disabled" }, { status: 409 });
  }
  let body: { confirm?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (body.confirm !== "DELETE") {
    return NextResponse.json({ error: "must_confirm_DELETE" }, { status: 400 });
  }
  lock();
  await deleteWallet();
  log.warn("wallet wiped from local DB");
  return NextResponse.json({ ok: true });
}
