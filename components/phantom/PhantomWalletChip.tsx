"use client";

import { useCallback } from "react";
import { useModal, useDisconnect, useSolana } from "@phantom/react-sdk";
import { shortAddr } from "@/lib/ui/format";
import { phantomConnectEnabled } from "@/lib/phantom/config";

export function PhantomWalletChip() {
  const enabled = phantomConnectEnabled();
  const { open } = useModal();
  const { disconnect } = useDisconnect();
  const { solana, isAvailable } = useSolana();

  const connect = useCallback(() => {
    open();
  }, [open]);

  if (!enabled) return null;

  const connected = isAvailable && solana?.isConnected && solana.publicKey;

  return (
    <span className="flex items-center gap-1.5 font-mono text-[10px]">
      {connected ? (
        <>
          <span className="text-emerald-700">Phantom {shortAddr(solana.publicKey!)}</span>
          <button type="button" className="btn-ghost text-[10px]" onClick={() => void disconnect()}>
            Disconnect
          </button>
        </>
      ) : (
        <button type="button" className="btn-ghost text-[10px]" onClick={connect}>
          Connect Phantom
        </button>
      )}
    </span>
  );
}
