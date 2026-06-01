"use client";

import { useCallback } from "react";
import { useSolana } from "@phantom/react-sdk";
import { VersionedTransaction } from "@solana/web3.js";
import { phantomConnectEnabled } from "@/lib/phantom/config";

type PrepareBuyResp = {
  error?: string;
  txBase64?: string;
  route?: string;
  entryVSol?: number | null;
};

type PrepareSellResp = {
  error?: string;
  txBase64?: string;
  route?: string;
};

type ConfirmResp = {
  ok?: boolean;
  error?: string;
  tradeId?: string | null;
};

function txSig(result: { signature?: string; hash?: string }): string {
  const sig = result.signature ?? result.hash;
  if (!sig) throw new Error("phantom_no_signature");
  return sig;
}

export function usePhantomLiveTrade() {
  const enabled = phantomConnectEnabled();
  const { solana, isAvailable } = useSolana();
  const publicKey = solana?.publicKey ?? null;
  const canPhantomTrade = Boolean(enabled && isAvailable && solana?.isConnected && publicKey);

  const phantomBuy = useCallback(
    async (opts: { mint: string; sizeSol: number; vSol?: number | null }) => {
      if (!canPhantomTrade || !solana || !publicKey) throw new Error("phantom_not_connected");

      const prep = await fetch("/api/trade/prepare-buy", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mint: opts.mint,
          sizeSol: opts.sizeSol,
          publicKey,
          vSol: opts.vSol ?? undefined,
        }),
      });
      const prepared = (await prep.json()) as PrepareBuyResp;
      if (!prep.ok || !prepared.txBase64) {
        throw new Error(prepared.error ?? `prepare-buy HTTP ${prep.status}`);
      }

      const tx = VersionedTransaction.deserialize(Buffer.from(prepared.txBase64, "base64"));
      const sent = await solana.signAndSendTransaction(tx);
      const signature = txSig(sent);

      const conf = await fetch("/api/trade/confirm-live", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          side: "buy",
          mint: opts.mint,
          sizeSol: opts.sizeSol,
          signature,
          route: prepared.route,
          entryVSol: prepared.entryVSol,
          publicKey,
        }),
      });
      const confirmed = (await conf.json()) as ConfirmResp;
      if (!conf.ok || !confirmed.ok) {
        throw new Error(confirmed.error ?? `confirm-live HTTP ${conf.status}`);
      }
      return { signature, tradeId: confirmed.tradeId ?? null };
    },
    [canPhantomTrade, publicKey, solana],
  );

  const phantomSell = useCallback(
    async (opts: { mint: string; percent?: number; vSol?: number | null }) => {
      if (!canPhantomTrade || !solana || !publicKey) throw new Error("phantom_not_connected");
      const percent = opts.percent ?? 100;

      const prep = await fetch("/api/trade/prepare-sell", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mint: opts.mint,
          percent,
          publicKey,
          vSol: opts.vSol ?? undefined,
        }),
      });
      const prepared = (await prep.json()) as PrepareSellResp;
      if (!prep.ok || !prepared.txBase64) {
        throw new Error(prepared.error ?? `prepare-sell HTTP ${prep.status}`);
      }

      const tx = VersionedTransaction.deserialize(Buffer.from(prepared.txBase64, "base64"));
      const sent = await solana.signAndSendTransaction(tx);
      const signature = txSig(sent);

      const conf = await fetch("/api/trade/confirm-live", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          side: "sell",
          mint: opts.mint,
          percent,
          signature,
          route: prepared.route,
          publicKey,
        }),
      });
      const confirmed = (await conf.json()) as ConfirmResp;
      if (!conf.ok || !confirmed.ok) {
        throw new Error(confirmed.error ?? `confirm-live HTTP ${conf.status}`);
      }
      return { signature, tradeId: confirmed.tradeId ?? null };
    },
    [canPhantomTrade, publicKey, solana],
  );

  return { canPhantomTrade, publicKey, phantomBuy, phantomSell };
}
