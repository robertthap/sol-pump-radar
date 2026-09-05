"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useTradingMode } from "@/components/TradingModeProvider";
import { submitDemoReset } from "@/lib/trade-client";
import { useSolPrice, solToAudDisplay } from "@/lib/ui/useSolUsd";

const WalletPanel = dynamic(
  () => import("@/components/WalletPanel").then((m) => ({ default: m.WalletPanel })),
  { ssr: false, loading: () => <span className="pill text-muted">wallet…</span> },
);

type Props = {
  /** Large strip for Wallet page; compact row for Auto-trade card. */
  variant?: "hero" | "compact";
  /** Demo-only: show reset account control (Wallet page). */
  showDemoReset?: boolean;
  /** Real-only: unlock / address controls (Wallet page). */
  showWalletControls?: boolean;
  className?: string;
};

export function SessionWalletBalance({
  variant = "hero",
  showDemoReset = false,
  showWalletControls = false,
  className = "",
}: Props) {
  const { mode, demo, refresh } = useTradingMode();
  const { aud: solAud } = useSolPrice();
  const [realBalanceSol, setRealBalanceSol] = useState<number | null>(null);
  const [realUnlocked, setRealUnlocked] = useState(false);
  const [resetBusy, setResetBusy] = useState(false);

  const loadReal = useCallback(async () => {
    if (mode !== "real") return;
    try {
      const r = await fetch("/api/wallet/status", { cache: "no-store" });
      if (!r.ok) return;
      const j = (await r.json()) as {
        isUnlocked?: boolean;
        balanceSol?: number | null;
      };
      setRealUnlocked(j.isUnlocked === true);
      setRealBalanceSol(
        j.isUnlocked && j.balanceSol != null && Number.isFinite(j.balanceSol) ? j.balanceSol : null,
      );
    } catch {
      /* keep last */
    }
  }, [mode]);

  useEffect(() => {
    void loadReal();
  }, [loadReal]);

  useEffect(() => {
    if (mode !== "real") return;
    const id = window.setInterval(() => void loadReal(), 15_000);
    return () => window.clearInterval(id);
  }, [mode, loadReal]);

  async function resetDemo() {
    if (
      !window.confirm(
        "Reset demo account to a fresh start? This wipes ALL demo holdings, closed trades, PnL and balance. System learning is kept.",
      )
    )
      return;
    setResetBusy(true);
    try {
      const res = await submitDemoReset();
      if (!res.ok) window.alert(res.error ?? "Demo reset failed");
      else await refresh();
    } catch (e) {
      window.alert(e instanceof Error ? e.message : String(e));
    } finally {
      setResetBusy(false);
    }
  }

  if (mode !== "demo" && mode !== "real") return null;

  const isDemo = mode === "demo";
  const equity =
    isDemo && demo ? (demo.equitySol ?? demo.balanceSol) : realBalanceSol;
  const label = isDemo ? "Demo wallet" : "Wallet balance";

  if (variant === "compact") {
    return (
      <div
        className={`card flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-xs ${className}`}
      >
        <div className="min-w-0">
          <p className="text-[10px] uppercase tracking-wide text-muted">{label}</p>
          {equity != null ? (
            <p className="font-mono text-base font-semibold text-fg">
              {equity.toFixed(3)} <span className="text-sm font-normal text-muted">SOL</span>
              <span className="ml-2 text-[11px] text-muted">{solToAudDisplay(equity, solAud)}</span>
            </p>
          ) : (
            <p className="text-muted">
              {isDemo ? "Loading…" : realUnlocked ? "—" : "Unlock wallet to see balance"}
            </p>
          )}
        </div>
        {isDemo && demo && (
          <p className="text-[10px] text-muted">
            cash {demo.balanceSol.toFixed(3)} · locked {demo.lockedSol.toFixed(3)}
          </p>
        )}
      </div>
    );
  }

  return (
    <div
      className={`card flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between ${className}`}
    >
      <div className="min-w-0">
        <h1 className="mb-1 text-lg font-semibold tracking-tight text-fg">Wallet</h1>
        <p className="text-[10px] uppercase tracking-wide text-muted">{label}</p>
        {equity != null ? (
          <>
            <p className="mt-1 font-mono text-3xl font-semibold tracking-tight text-fg sm:text-4xl">
              {equity.toFixed(3)}
              <span className="ml-2 text-lg font-normal text-muted">SOL</span>
            </p>
            <p className="mt-1 text-sm text-muted">
              {solToAudDisplay(equity, solAud)}
              <span className="ml-2 text-[10px] text-muted">(1 SOL = A${solAud.toFixed(0)})</span>
            </p>
          </>
        ) : (
          <p className="mt-2 text-sm text-muted">
            {isDemo
              ? "Loading demo balance…"
              : realUnlocked
                ? "Balance unavailable"
                : "Unlock your trading wallet to see SOL balance"}
          </p>
        )}
        {isDemo && demo && (
          <p className="mt-2 text-[11px] text-muted">
            Cash {demo.balanceSol.toFixed(3)} SOL · Locked in positions {demo.lockedSol.toFixed(3)}{" "}
            SOL
          </p>
        )}
      </div>
      <div className="flex shrink-0 flex-col items-stretch gap-2 sm:items-end">
        {showWalletControls && mode === "real" && <WalletPanel />}
        {showDemoReset && isDemo && (
          <button
            type="button"
            onClick={() => void resetDemo()}
            disabled={resetBusy}
            className="rounded border border-border px-3 py-1.5 text-xs text-muted hover:bg-panel2 hover:text-fg"
          >
            {resetBusy ? "Resetting…" : "Reset demo account"}
          </button>
        )}
        {mode === "real" && !showWalletControls && !realUnlocked && (
          <Link href="/wallet" className="text-xs text-accent hover:underline">
            Set up wallet →
          </Link>
        )}
      </div>
    </div>
  );
}
