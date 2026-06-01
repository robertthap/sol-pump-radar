import { NextResponse } from "next/server";
import { bootDb } from "@/lib/db/client";
import { getStatus, peekKeypair } from "@/lib/wallet/session";
import { fetchSolBalance } from "@/lib/wallet/balance";
import { env, rpcHttpUrls } from "@/lib/env";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  await bootDb();
  const allowWebSession = env().WEB_WALLET_SESSION === "on";
  const status = await getStatus();
  let balanceSol: number | null = null;
  if (allowWebSession && status.isUnlocked && peekKeypair() && status.publicKey) {
    const rpcs = rpcHttpUrls();
    if (rpcs.length) balanceSol = await fetchSolBalance(status.publicKey, rpcs[0]!);
  }
  return NextResponse.json({
    ...status,
    balanceSol,
    autoLockMinutes: env().WALLET_AUTO_LOCK_MINUTES,
    webWalletSession: allowWebSession ? "enabled" : "disabled",
    live: {
      execution: env().LIVE_EXECUTION,
      dryRun: env().LIVE_DRY_RUN,
      maxPerTradeSol: env().LIVE_MAX_PER_TRADE_SOL,
      maxDailySol: env().LIVE_MAX_DAILY_SOL,
      slippageBps: env().LIVE_SLIPPAGE_BPS,
    },
  });
}
