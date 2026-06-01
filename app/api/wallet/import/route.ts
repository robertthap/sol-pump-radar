import { NextRequest, NextResponse } from "next/server";
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";
import { bootDb } from "@/lib/db/client";
import { encryptSecret, blobToString } from "@/lib/wallet/crypto";
import { saveWallet, walletExists } from "@/lib/wallet/storage";
import { logger } from "@/lib/log";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const log = logger("api:wallet:import");

function parseSecretKey(input: string): Uint8Array {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("empty secret");
  if (trimmed.startsWith("[")) {
    const arr = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(arr)) throw new Error("expected array");
    if (arr.length !== 64) throw new Error(`expected 64 bytes, got ${arr.length}`);
    const out = new Uint8Array(64);
    for (let i = 0; i < 64; i++) {
      const v = arr[i];
      if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 255) {
        throw new Error("array contains non-byte");
      }
      out[i] = v;
    }
    return out;
  }
  const decoded = bs58.decode(trimmed);
  if (decoded.length !== 64) {
    throw new Error(`base58 secret is ${decoded.length} bytes, expected 64`);
  }
  return decoded;
}

export async function POST(req: NextRequest) {
  await bootDb();
  let body: { passphrase?: unknown; secretKey?: unknown; label?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const passphrase = typeof body.passphrase === "string" ? body.passphrase : "";
  if (passphrase.length < 6) {
    return NextResponse.json({ error: "passphrase_too_short" }, { status: 400 });
  }
  const rawSecret = typeof body.secretKey === "string" ? body.secretKey : "";
  if (!rawSecret) {
    return NextResponse.json({ error: "secretKey_required" }, { status: 400 });
  }
  const label = typeof body.label === "string" && body.label ? body.label.slice(0, 32) : "main";

  if (await walletExists()) {
    return NextResponse.json({ error: "wallet_exists" }, { status: 409 });
  }

  let secret: Uint8Array;
  try {
    secret = parseSecretKey(rawSecret);
  } catch (e) {
    return NextResponse.json(
      { error: "invalid_secret", detail: String(e instanceof Error ? e.message : e) },
      { status: 400 },
    );
  }

  let kp: Keypair;
  try {
    kp = Keypair.fromSecretKey(secret);
  } catch (e) {
    return NextResponse.json(
      { error: "invalid_keypair", detail: String(e instanceof Error ? e.message : e) },
      { status: 400 },
    );
  }

  try {
    const blob = await encryptSecret(secret, passphrase);
    const encoded = blobToString(blob);
    const row = await saveWallet({
      source: "imported",
      publicKey: kp.publicKey.toBase58(),
      encryptedSecret: encoded,
      label,
    });
    log.info("wallet imported", { publicKey: row.publicKey });
    return NextResponse.json({ ok: true, publicKey: row.publicKey, source: "imported" });
  } finally {
    for (let i = 0; i < secret.length; i++) secret[i] = 0;
  }
}
