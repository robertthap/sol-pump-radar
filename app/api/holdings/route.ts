import { NextResponse } from "next/server";
import { bootDb } from "@/lib/db/client";
import { fetchLiveHoldingsTrades } from "@/lib/db/repos/live-trades";
import { peekKeypair, getActivePubkey } from "@/lib/wallet/session";
import { fetchAllTokenBalances } from "@/lib/wallet/holdings";
import { rpcHttpUrls } from "@/lib/env";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Returns:
 *   - active wallet pubkey (or null if locked)
 *   - all open live trades, each annotated with on-chain balance
 *   - extra wallet holdings that don't have a matching open trade (orphans)
 */
export async function GET() {
  await bootDb();
  const pubkey = getActivePubkey();
  const rpcs = rpcHttpUrls();

  const dbTrades = await fetchLiveHoldingsTrades();

  let onChain: Map<string, { amount: string; uiAmount: number; decimals: number; account: string }> = new Map();
  let onChainError: string | null = null;
  if (pubkey && peekKeypair() && rpcs.length > 0) {
    try {
      const all = await fetchAllTokenBalances(pubkey, rpcs[0]!);
      onChain = new Map(
        Array.from(all.entries()).map(([mint, b]) => [
          mint,
          { amount: b.amount.toString(), uiAmount: b.uiAmount, decimals: b.decimals, account: b.account },
        ]),
      );
    } catch (e) {
      onChainError = e instanceof Error ? e.message : String(e);
    }
  }

  const tradeMintSet = new Set(dbTrades.map((t) => t.mint));
  const tradesWithOnChain = dbTrades.map((t) => {
    const oc = onChain.get(t.mint);
    return {
      id: t.id,
      mint: t.mint,
      sizeSol: t.sizeSol,
      entryPrice: t.entryPrice,
      route: t.route,
      status: t.status,
      dryRun: t.dryRun,
      txOpen: t.txOpen,
      openedAt: t.openedAt.toISOString(),
      onChainAmount: oc?.amount ?? null,
      onChainUiAmount: oc?.uiAmount ?? null,
      onChainAccount: oc?.account ?? null,
      reconciled: pubkey == null ? null : !!oc && BigInt(oc?.amount ?? "0") > 0n,
    };
  });

  const orphans = pubkey
    ? Array.from(onChain.entries())
        .filter(([mint, b]) => !tradeMintSet.has(mint) && BigInt(b.amount) > 0n)
        .map(([mint, b]) => ({
          mint,
          amount: b.amount,
          uiAmount: b.uiAmount,
          decimals: b.decimals,
          account: b.account,
        }))
    : [];

  return NextResponse.json({
    walletPubkey: pubkey,
    walletUnlocked: !!peekKeypair(),
    rpcConfigured: rpcs.length > 0,
    onChainError,
    trades: tradesWithOnChain,
    orphans,
    counts: {
      openTrades: dbTrades.length,
      reconciled: tradesWithOnChain.filter((t) => t.reconciled).length,
      missingOnChain: tradesWithOnChain.filter((t) => t.reconciled === false).length,
      orphans: orphans.length,
    },
  });
}
