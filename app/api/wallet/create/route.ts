import { NextRequest, NextResponse } from "next/server";
import { Keypair } from "@solana/web3.js";
import { bootDb } from "@/lib/db/client";
import { encryptSecret, blobToString } from "@/lib/wallet/crypto";
import { saveWallet, walletExists } from "@/lib/wallet/storage";
import { logger } from "@/lib/log";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const log = logger("api:wallet:create");

export async function POST(req: NextRequest) {
  await bootDb();
  if (env().WEB_WALLET_SESSION !== "on") {
    return NextResponse.json(
      { error: "web_wallet_session_disabled", hint: "Set WEB_WALLET_SESSION=on to manage wallet keys from the web process." },
      { status: 409 },
    );
  }
  let body: { passphrase?: unknown; label?: unknown };
  try {
    body = (await req.json()) as { passphrase?: unknown; label?: unknown };
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const passphrase = typeof body.passphrase === "string" ? body.passphrase : "";
  if (passphrase.length < 6) {
    return NextResponse.json({ error: "passphrase_too_short" }, { status: 400 });
  }
  const label = typeof body.label === "string" && body.label ? body.label.slice(0, 32) : "main";

  if (await walletExists()) {
    return NextResponse.json({ error: "wallet_exists" }, { status: 409 });
  }

  const kp = Keypair.generate();
  const secret = kp.secretKey;
  try {
    const blob = await encryptSecret(secret, passphrase);
    const encoded = blobToString(blob);
    const row = await saveWallet({
      source: "generated",
      publicKey: kp.publicKey.toBase58(),
      encryptedSecret: encoded,
      label,
    });
    log.info("wallet generated", { publicKey: row.publicKey });
    return NextResponse.json({ ok: true, publicKey: row.publicKey, source: "generated" });
  } finally {
    for (let i = 0; i < secret.length; i++) secret[i] = 0;
  }
}
