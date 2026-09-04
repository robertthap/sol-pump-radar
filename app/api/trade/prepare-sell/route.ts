import { NextResponse } from "next/server";
import { bootDb } from "@/lib/db/client";
import { getUiTradingMode } from "@/lib/db/repos/trading-mode";
import { buildUnsignedLiveSellTx } from "@/lib/executor/live-phantom";
import { env, rpcHttpUrls } from "@/lib/env";
import { resolvePumpTradeMint } from "@/lib/pump/resolve-price";
import { withRoutePerf } from "@/lib/runtime/with-route-perf";
import { assertLiveExecutionAllowed } from "@/lib/runtime/live-guards";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Returns base64 unsigned sell tx for Phantom signAndSendTransaction. */
export const POST = withRoutePerf(async (req: Request) => {
  await bootDb();
  if ((await getUiTradingMode()) === "demo") {
    return NextResponse.json({ error: "not_in_real_mode" }, { status: 409 });
  }

  let body: { mint?: unknown; percent?: unknown; publicKey?: unknown; vSol?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const mint = typeof body.mint === "string" ? body.mint.trim() : "";
  const publicKey = typeof body.publicKey === "string" ? body.publicKey.trim() : "";
  const hintVSol = typeof body.vSol === "number" ? body.vSol : Number(body.vSol);
  const percent =
    typeof body.percent === "number"
      ? body.percent
      : body.percent == null
        ? 100
        : Number(body.percent);

  if (!mint || mint.length < 32) {
    return NextResponse.json({ error: "invalid_mint" }, { status: 400 });
  }
  if (!publicKey || publicKey.length < 32) {
    return NextResponse.json({ error: "invalid_public_key" }, { status: 400 });
  }
  if (!Number.isFinite(percent) || percent <= 0 || percent > 100) {
    return NextResponse.json({ error: "invalid_percent" }, { status: 400 });
  }

  const resolved = await resolvePumpTradeMint(
    mint,
    Number.isFinite(hintVSol) && hintVSol > 0 ? hintVSol : null,
  );
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.error }, { status: 400 });
  }

  const rpcUrl = rpcHttpUrls()[0];
  if (!rpcUrl) return NextResponse.json({ error: "no_rpc" }, { status: 500 });
  if (env().LIVE_EXECUTION !== "on") {
    return NextResponse.json({ error: "live_disabled" }, { status: 409 });
  }
  // Selling is the de-risking direction, but it is still a real mainnet tx, and
  // this route previously honoured neither the circuit breaker nor the live
  // confirm token — quick-sell does both. Match it.
  const liveGate = await assertLiveExecutionAllowed();
  if (!liveGate.ok) {
    return NextResponse.json({ error: liveGate.reason }, { status: 409 });
  }

  const built = await buildUnsignedLiveSellTx({ mint, percent, publicKey, rpcUrl });
  if (!built.ok) {
    return NextResponse.json({ error: built.reason }, { status: 400 });
  }

  return NextResponse.json({ txBase64: built.txBase64, route: built.route });
});
