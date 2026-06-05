"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useSolPrice } from "@/lib/ui/useSolUsd";

type Health = {
  uiTradingMode: "demo" | "real" | null;
  liveExecution: "on" | "off";
  liveDryRun: "on" | "off";
  circuitBreaker: string | null;
};

/**
 * Always-visible session banner — one user-facing mode (Demo vs Real).
 * Runtime/worker details live on /runtime only.
 */
export function ModeBanner() {
  const [h, setH] = useState<Health | null>(null);
  const { aud: solAud } = useSolPrice();

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetch("/api/runtime/health", { cache: "no-store" });
        if (!r.ok) return;
        const j = (await r.json()) as Health;
        if (!cancelled) setH(j);
      } catch {
        /* keep last */
      }
    };
    void tick();
    const id = setInterval(() => void tick(), 5_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (!h) return null;

  const mode = h.uiTradingMode;
  const halted = h.circuitBreaker === "HALTED";
  const realLive =
    mode === "real" && h.liveExecution === "on" && h.liveDryRun !== "on";

  let tone: string;
  let title: string;
  let subtitle: string;

  if (mode === "real") {
    tone = realLive
      ? "bg-red-800/50 text-red-50 border-red-600/60"
      : "bg-amber-800/40 text-amber-50 border-amber-600/50";
    title = realLive ? "REAL WALLET — LIVE TRADING" : "REAL WALLET";
    subtitle = realLive
      ? "Trades can spend real SOL. You can lose everything."
      : h.liveDryRun === "on"
        ? "Wallet connected — live orders are in dry-run (not sent)."
        : "Unlock your wallet on the Wallet page to trade.";
  } else if (mode === "demo") {
    tone = "bg-emerald-800/45 text-emerald-50 border-emerald-600/50";
    title = "DEMO — PLAY MONEY";
    subtitle = "Simulated fills only. No real SOL at risk.";
  } else {
    tone = "bg-panel2 text-muted border-border";
    title = "NO WALLET SELECTED";
    subtitle = "Go home and pick Demo or Real to start.";
  }

  return (
    <div
      className={`flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b px-3 py-2 text-center text-xs sm:text-sm ${tone}`}
      role="status"
    >
      <span className="font-bold tracking-wide">{title}</span>
      <span className="opacity-90">{subtitle}</span>
      {halted && <span className="font-semibold text-red-200">Trading paused</span>}
      <span className="hidden text-[10px] opacity-75 sm:inline">
        1 SOL = A${solAud.toFixed(0)}
      </span>
      <Link href="/runtime" className="text-[10px] underline-offset-2 opacity-70 hover:underline">
        System status
      </Link>
    </div>
  );
}
