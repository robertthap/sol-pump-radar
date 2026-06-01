import { NextResponse } from "next/server";
import { bootDb } from "@/lib/db/client";
import { getUiTradingMode } from "@/lib/db/repos/trading-mode";
import { buildUnsignedLiveBuyTx } from "@/lib/executor/live-phantom";
import { resolvePumpTradeMint } from "@/lib/pump/resolve-price";
import { env } from "@/lib/env";
import { withRoutePerf } from "@/lib/runtime/with-route-perf";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Returns base64 unsigned tx for Phantom signAndSendTransaction (real mode, manual trades). */
export const POST = withRoutePerf(async (req: Request) => {
  await bootDb();
  if ((await getUiTradingMode()) === "demo") {
    return NextResponse.json({ error: "not_in_real_mode" }, { status: 409 });
  }

  let body: { mint?: unknown; sizeSol?: unknown; publicKey?: unknown; vSol?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const mint = typeof body.mint === "string" ? body.mint.trim() : "";
  const publicKey = typeof body.publicKey === "string" ? body.publicKey.trim() : "";
  const sizeSol = typeof body.sizeSol === "number" ? body.sizeSol : Number(body.sizeSol);
  const hintVSol = typeof body.vSol === "number" ? body.vSol : Number(body.vSol);

  if (!mint || mint.length < 32) {
    return NextResponse.json({ error: "invalid_mint" }, { status: 400 });
  }
  if (!publicKey || publicKey.length < 32) {
    return NextResponse.json({ error: "invalid_public_key" }, { status: 400 });
  }
  if (!Number.isFinite(sizeSol) || sizeSol <= 0) {
    return NextResponse.json({ error: "invalid_size" }, { status: 400 });
  }

  const resolved = await resolvePumpTradeMint(
    mint,
    Number.isFinite(hintVSol) && hintVSol > 0 ? hintVSol : null,
  );
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.error }, { status: 400 });
  }

  if (env().LIVE_EXECUTION !== "on") {
    return NextResponse.json({ error: "live_disabled" }, { status: 409 });
  }

  const built = await buildUnsignedLiveBuyTx({ mint, sizeSol, publicKey });
  if (!built.ok) {
    return NextResponse.json({ error: built.reason }, { status: 400 });
  }

  return NextResponse.json({
    txBase64: built.txBase64,
    route: built.route,
    entryVSol: resolved.vSol,
  });
});
