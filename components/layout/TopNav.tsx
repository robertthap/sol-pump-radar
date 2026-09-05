"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { LogOut, Menu, RotateCcw, X } from "lucide-react";
import { useTradingMode } from "@/components/TradingModeProvider";
import { useTickerOptional } from "@/components/ticker/TickerProvider";
import { ModeGlossary } from "@/components/ModeGlossary";
import { submitDemoReset } from "@/lib/trade-client";

const HaltButton = dynamic(() => import("@/components/HaltButton").then((m) => ({ default: m.HaltButton })), {
  ssr: false,
});

/**
 * Two destinations, the session pill, bot state, and the safety controls.
 * Nothing here polls: bot state comes from the ticker when /trade is mounted,
 * otherwise from the mode provider's activeSession.
 */
const NAV = [
  { href: "/trade", label: "Trade" },
  { href: "/wallet", label: "Wallet" },
] as const;

export function TopNav() {
  const pathname = usePathname();
  const { mode, activeSession, exitSession, refresh } = useTradingMode();
  const ticker = useTickerOptional();
  const [logOffBusy, setLogOffBusy] = useState(false);
  const [resetBusy, setResetBusy] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => setMobileOpen(false), [pathname]);

  const inSession = mode === "demo" || mode === "real";
  const botRunning = ticker?.data ? ticker.data.bot.running : activeSession;
  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`);

  async function logOff() {
    if (logOffBusy) return;
    setLogOffBusy(true);
    try {
      await exitSession();
    } finally {
      setLogOffBusy(false);
    }
  }

  async function resetDemo() {
    if (resetBusy) return;
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

  const pill = inSession && (
    <span
      className={`shrink-0 rounded-md px-2 py-1 text-xs font-semibold ${mode === "demo" ? "bg-accent/15 text-accent" : "bg-warn/15 text-warn"}`}
      title={mode === "demo" ? "Demo session - play money only" : "Real session - connected wallet; live execution only when enabled"}
    >
      {mode === "demo" ? "Demo" : "Real"}
    </span>
  );

  const botState = inSession && (
    <span className={`inline-flex shrink-0 items-center gap-1.5 text-xs font-medium ${botRunning ? "text-ok" : "text-muted"}`}>
      <span aria-hidden="true" className={`inline-block h-2 w-2 rounded-full ${botRunning ? "bg-ok" : "border border-muted"}`} />
      {botRunning ? "Bot running" : "Bot stopped"}
    </span>
  );

  const sessionButtons = inSession && (
    <>
      {mode === "demo" && (
        <button
          type="button"
          onClick={() => void resetDemo()}
          disabled={resetBusy}
          className="inline-flex min-h-9 shrink-0 cursor-pointer items-center gap-1 rounded-lg border border-border px-2 text-xs text-muted transition-colors hover:bg-panel2 hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
          title="Reset the demo account to a fresh start (keeps system learning)"
        >
          <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
          {resetBusy ? "…" : "Reset"}
        </button>
      )}
      <button
        type="button"
        onClick={() => void logOff()}
        disabled={logOffBusy}
        className="inline-flex min-h-9 shrink-0 cursor-pointer items-center gap-1 rounded-lg border border-border px-2 text-xs text-muted transition-colors hover:bg-panel2 hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
        title="End this session and return to the home wallet chooser"
      >
        <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
        {logOffBusy ? "…" : "Log off"}
      </button>
    </>
  );

  return (
    <header className="sticky top-0 z-40 border-b border-border bg-panel/95 backdrop-blur-sm">
      <div className="flex min-h-14 items-center gap-2 px-3 py-2 lg:gap-3 lg:px-5">
        <Link href="/trade" prefetch={false} className="flex min-h-11 min-w-11 shrink-0 items-center gap-2" aria-label="Sol Pump Radar - Trade">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-500 text-sm font-bold text-black" aria-hidden="true">
            P
          </span>
          <span className="hidden text-base font-bold tracking-tight text-fg sm:inline">
            Sol Pump <span className="text-accent">Radar</span>
          </span>
        </Link>

        <nav aria-label="Primary" className="ml-2 flex items-center gap-1">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              prefetch={false}
              aria-current={isActive(item.href) ? "page" : undefined}
              className={`tab inline-flex min-h-11 items-center ${isActive(item.href) ? "tab-active" : ""}`}
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-2">
          {botState}
          {pill}
          <span className="hidden md:inline">
            <ModeGlossary />
          </span>
          <span className="hidden md:inline-flex">
            <HaltButton />
          </span>
          <span className="hidden items-center gap-2 md:flex">{sessionButtons}</span>
          <button
            type="button"
            onClick={() => setMobileOpen((o) => !o)}
            className="inline-flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted hover:bg-panel2 hover:text-fg md:hidden"
            aria-label={mobileOpen ? "Close menu" : "Open menu"}
            aria-expanded={mobileOpen}
          >
            {mobileOpen ? <X className="h-5 w-5" aria-hidden="true" /> : <Menu className="h-5 w-5" aria-hidden="true" />}
          </button>
        </div>
      </div>

      {mobileOpen && (
        <div className="space-y-2 border-t border-border bg-panel2 px-3 py-3 md:hidden">
          <div className="flex flex-wrap items-center gap-2">{sessionButtons}</div>
          <HaltButton />
        </div>
      )}
    </header>
  );
}
