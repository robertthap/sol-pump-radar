"use client";
import { useCallback, useEffect, useState } from "react";
import { shortAddr, fmtSol } from "@/lib/ui/format";
import { useVisibleInterval } from "@/lib/ui/useVisibleInterval";
import { useTradingMode } from "@/components/TradingModeProvider";
import { WalletSetupModal } from "./WalletSetupModal";
import { PhantomWalletChip } from "@/components/phantom/PhantomWalletChip";
import { localVaultFallbackEnabled, phantomConnectEnabled } from "@/lib/phantom/config";

type Status = {
  hasWallet: boolean;
  isUnlocked: boolean;
  publicKey: string | null;
  autoLockAt: number | null;
  source: "generated" | "imported" | null;
  balanceSol: number | null;
  autoLockMinutes: number;
  live: {
    execution: "on" | "off";
    dryRun: "on" | "off";
    maxPerTradeSol: number;
    maxDailySol: number;
    slippageBps: number;
  };
};

export function WalletPanel() {
  const { mode } = useTradingMode();
  const [status, setStatus] = useState<Status | null>(null);
  const [showSetup, setShowSetup] = useState(false);
  const [showUnlock, setShowUnlock] = useState(false);
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState<number>(Date.now());

  const refreshStatus = useCallback(async () => {
    try {
      const r = await fetch("/api/wallet/status", { cache: "no-store" });
      if (!r.ok) return;
      setStatus((await r.json()) as Status);
    } catch {
      /* swallow */
    }
  }, []);

  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);

  const tick = useCallback(() => {
    if (mode === "real") void refreshStatus();
  }, [mode, refreshStatus]);

  useVisibleInterval(tick, mode === "real" ? 30_000 : 0, [tick, mode]);
  useVisibleInterval(() => setNow(Date.now()), 1_000, []);

  async function unlock() {
    setError(null);
    setBusy(true);
    try {
      const r = await fetch("/api/wallet/unlock", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ passphrase: pass }),
      });
      if (r.status === 401) {
        setError("wrong passphrase");
        return;
      }
      if (!r.ok) {
        setError("HTTP " + r.status);
        return;
      }
      setPass("");
      setShowUnlock(false);
      await refreshStatus();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function lock() {
    setBusy(true);
    try {
      await fetch("/api/wallet/lock", { method: "POST" });
      await refreshStatus();
    } finally {
      setBusy(false);
    }
  }

  async function wipe() {
    if (
      !window.confirm(
        "This permanently deletes the encrypted wallet from local storage. You will lose access to funds unless you have the secret key backed up elsewhere. Continue?",
      )
    )
      return;
    setBusy(true);
    try {
      const r = await fetch("/api/wallet/wipe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: "DELETE" }),
      });
      if (!r.ok) {
        setError("wipe failed");
        return;
      }
      await refreshStatus();
    } finally {
      setBusy(false);
    }
  }

  if (mode !== "real") return null;

  const showPhantom = phantomConnectEnabled();
  const showLocalVault = !showPhantom || localVaultFallbackEnabled();

  if (!status && showLocalVault) {
    return <span className="pill text-muted">wallet…</span>;
  }

  if (showLocalVault && status && !status.hasWallet) {
    return (
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        {showPhantom ? <PhantomWalletChip /> : null}
        {showPhantom ? <span className="text-muted">or</span> : null}
        <button type="button" className="btn btn-ghost btn-ok" onClick={() => setShowSetup(true)}>
          {showPhantom ? "Local vault" : "Set up trading wallet"}
        </button>
        {showSetup && <WalletSetupModal onClose={() => setShowSetup(false)} />}
      </div>
    );
  }

  if (!showLocalVault && showPhantom) {
    return (
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        <PhantomWalletChip />
      </div>
    );
  }

  if (!status) {
    return <span className="pill text-muted">wallet…</span>;
  }

  if (!status.hasWallet) {
    return (
      <>
        <button type="button" className="btn btn-ghost btn-ok" onClick={() => setShowSetup(true)}>
          Set up trading wallet
        </button>
        {showSetup && <WalletSetupModal onClose={() => setShowSetup(false)} />}
      </>
    );
  }

  const lockSecs =
    status.autoLockAt != null ? Math.max(0, Math.floor((status.autoLockAt - now) / 1000)) : null;
  const mm = lockSecs != null ? Math.floor(lockSecs / 60) : null;
  const ss = lockSecs != null ? String(lockSecs % 60).padStart(2, "0") : null;

  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs">
      {showPhantom ? <PhantomWalletChip /> : null}
      {showPhantom && showLocalVault ? <span className="text-muted">·</span> : null}
      <span className="pill text-muted" title={status.publicKey ?? ""}>
        {shortAddr(status.publicKey, 4, 4)}
      </span>
      {status.isUnlocked ? (
        <>
          <span className="pill text-ok">
            {fmtSol(status.balanceSol, 4)} SOL
          </span>
          {lockSecs != null && (
            <span className="text-[10px] text-muted" title="auto-lock countdown">
              {mm}:{ss}
            </span>
          )}
          <button
            type="button"
            className="btn btn-ghost btn-danger"
            onClick={lock}
            disabled={busy}
          >
            Lock
          </button>
          <button
            type="button"
            className="text-[10px] text-muted underline-offset-2 hover:underline"
            onClick={wipe}
            disabled={busy}
            title="Delete the encrypted wallet from this machine"
          >
            wipe
          </button>
        </>
      ) : showUnlock ? (
        <>
          <input
            type="password"
            value={pass}
            onChange={(e) => setPass(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") unlock();
            }}
            placeholder="passphrase"
            className="rounded border border-border bg-panel/60 px-2 py-1 font-mono text-xs"
            autoComplete="current-password"
            autoFocus
            disabled={busy}
          />
          <button
            type="button"
            className="btn btn-ghost btn-ok"
            onClick={unlock}
            disabled={busy || !pass}
          >
            {busy ? "…" : "Unlock"}
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              setShowUnlock(false);
              setError(null);
              setPass("");
            }}
            disabled={busy}
          >
            Cancel
          </button>
          {error && <span className="text-[10px] text-bad">{error}</span>}
        </>
      ) : (
        <button type="button" className="btn btn-ghost btn-ok" onClick={() => setShowUnlock(true)}>
          Unlock
        </button>
      )}
    </div>
  );
}
