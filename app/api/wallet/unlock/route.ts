import { NextRequest, NextResponse } from "next/server";
import { bootDb } from "@/lib/db/client";
import { unlock } from "@/lib/wallet/session";
import { walletExists } from "@/lib/wallet/storage";
import { logger } from "@/lib/log";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const log = logger("api:wallet:unlock");

export async function POST(req: NextRequest) {
  await bootDb();
  if (env().WEB_WALLET_SESSION !== "on") {
    return NextResponse.json(
      { error: "web_wallet_session_disabled", hint: "Set WEB_WALLET_SESSION=on to enable legacy web unlock." },
      { status: 409 },
    );
  }
  let body: { passphrase?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const passphrase = typeof body.passphrase === "string" ? body.passphrase : "";
  if (!passphrase) return NextResponse.json({ error: "passphrase_required" }, { status: 400 });

  if (!(await walletExists())) {
    return NextResponse.json({ error: "no_wallet" }, { status: 404 });
  }

  try {
    const r = await unlock(passphrase);
    return NextResponse.json({ ok: true, publicKey: r.publicKey });
  } catch (e) {
    // Don't leak which specific failure mode it was — just 401 on auth failures
    // and 500 on unexpected internal errors.
    const msg = String(e instanceof Error ? e.message : e);
    if (/decryption failed/i.test(msg) || /passphrase/i.test(msg)) {
      log.warn("unlock rejected (bad passphrase)");
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    log.error("unlock failed", { err: msg });
    return NextResponse.json({ error: "unlock_failed" }, { status: 500 });
  }
}
