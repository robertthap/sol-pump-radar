"use client";

import { useEffect, useState } from "react";
import { useTradingMode } from "@/components/TradingModeProvider";
import { useTickerOptional } from "@/components/ticker/TickerProvider";

/**
 * Always-visible session banner - one user-facing mode (Demo vs Real).
 *
 * Reads the mode provider (and the ticker when /trade is mounted) instead of
 * polling /api/runtime/health every 5 s on every route as it used to. Zero
 * requests of its own.
 */
export function ModeBanner() {
  const { mode, liveExecution, liveDryRun } = useTradingMode();
  const ticker = useTickerOptional();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null; // mode is hydrated client-side; avoid an SSR/client mismatch

  const halted = ticker?.data?.status.breaker === "HALTED";
  const realLive = mode === "real" && liveExecution === "on" && liveDryRun !== "on";

  let tone: string;
  let title: string;
  let subtitle: string;
  if (mode === "real") {
    tone = realLive ? "bg-red-800/50 text-red-50 border-red-600/60" : "bg-amber-800/40 text-amber-50 border-amber-600/50";
    title = realLive ? "REAL WALLET - LIVE TRADING" : "REAL WALLET";
    subtitle = realLive
      ? "Trades can spend real SOL. You can lose everything."
      : liveDryRun === "on"
        ? "Wallet connected - live orders are in dry-run (not sent)."
        : "Unlock your wallet on the Wallet page to trade.";
  } else if (mode === "demo") {
    tone = "bg-emerald-800/45 text-emerald-50 border-emerald-600/50";
    title = "DEMO - PLAY MONEY";
    subtitle = "Simulated fills only. No real SOL at risk.";
  } else {
    tone = "bg-panel2 text-muted border-border";
    title = "NO WALLET SELECTED";
    subtitle = "Go home and pick Demo or Real to start.";
  }

  return (
    <div className={`flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b px-3 py-2 text-center text-xs sm:text-sm ${tone}`} role="status">
      <span className="font-bold tracking-wide">{title}</span>
      <span className="opacity-90">{subtitle}</span>
      {halted && <span className="font-semibold text-red-200">Trading paused</span>}
    </div>
  );
}
