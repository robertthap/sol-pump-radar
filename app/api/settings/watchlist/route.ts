import { NextResponse } from "next/server";
import { bootDb } from "@/lib/db/client";
import { parseWatchlistInput } from "@/lib/watchlist/parse";
import { addWatchedWallets, listWatchedWallets, removeWatchedWallet } from "@/lib/db/repos/wallet-watchlist";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * The operator's smart-money wallet list.
 *
 * Writes go through addWatchedWallets / removeWatchedWallet, which own the
 * executeWebMutation gate. Validation happens here, before the repo, so the
 * per-address rejection reasons reach the UI intact - "that is an Ethereum
 * address" is the whole point of this endpoint.
 */

export async function GET() {
  await bootDb();
  const wallets = await listWatchedWallets();
  return NextResponse.json({ wallets });
}

export async function POST(req: Request) {
  await bootDb();
  let body: { addresses?: unknown; label?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  // Accept a pasted blob or an array; the UI sends a textarea, scripts send JSON.
  const raw = Array.isArray(body.addresses)
    ? body.addresses.map((a) => String(a)).join("\n")
    : typeof body.addresses === "string"
      ? body.addresses
      : null;
  if (raw == null) {
    return NextResponse.json({ error: "addresses must be a string or an array of strings" }, { status: 400 });
  }

  const label = typeof body.label === "string" && body.label.trim() ? body.label.trim().slice(0, 64) : null;
  const parsed = parseWatchlistInput(raw);

  // A batch of only-bad addresses is a 400 so the caller cannot mistake it for
  // success; a mixed batch stores the good ones and still reports the bad.
  if (parsed.accepted.length === 0) {
    return NextResponse.json(
      { error: "no valid Solana addresses", rejected: parsed.rejected, duplicates: parsed.duplicates },
      { status: 400 },
    );
  }

  const { added, reactivated } = await addWatchedWallets(parsed.accepted, label);
  const wallets = await listWatchedWallets();
  return NextResponse.json({
    ok: true,
    added,
    reactivated,
    accepted: parsed.accepted.length,
    rejected: parsed.rejected,
    duplicates: parsed.duplicates,
    wallets,
  });
}

export async function DELETE(req: Request) {
  await bootDb();
  const wallet = new URL(req.url).searchParams.get("wallet");
  if (!wallet) return NextResponse.json({ error: "wallet query parameter is required" }, { status: 400 });
  const removed = await removeWatchedWallet(wallet);
  const wallets = await listWatchedWallets();
  return NextResponse.json({ ok: true, removed, wallets });
}
