"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import {
  Activity,
  BarChart3,
  Bell,
  Brain,
  ChevronDown,
  FlaskConical,
  LineChart,
  LogOut,
  Menu,
  Radio,
  RotateCcw,
  Wallet,
  X,
  Zap,
} from "lucide-react";
import { useTradingMode } from "@/components/TradingModeProvider";
import { ModeGlossary } from "@/components/ModeGlossary";
import { submitDemoReset } from "@/lib/trade-client";

const NotificationsBell = dynamic(
  () => import("@/components/NotificationsBell").then((m) => ({ default: m.NotificationsBell })),
  { ssr: false },
);
const HaltButton = dynamic(
  () => import("@/components/HaltButton").then((m) => ({ default: m.HaltButton })),
  { ssr: false },
);

const PRIMARY_NAV = [
  { href: "/trade", label: "Trade", icon: Activity },
  { href: "/market", label: "Market", icon: Radio },
  { href: "/signals", label: "Signals", icon: Zap },
  { href: "/wallet", label: "Wallet", icon: Wallet },
] as const;

// Trader-facing deep dives.
const ADVANCED_NAV = [
  { href: "/analytics", label: "Analytics", icon: BarChart3 },
  { href: "/smart-money", label: "Smart money", icon: LineChart },
  { href: "/backtest", label: "Backtest", icon: FlaskConical },
  { href: "/notifications", label: "Notifications", icon: Bell },
] as const;

// Operator / infra dashboards — not part of a trader's buy→manage→sell loop.
const OPERATOR_NAV = [
  { href: "/mission", label: "Mission control", icon: Activity },
  { href: "/learning", label: "Learning", icon: Brain },
  { href: "/rings", label: "Wallet rings", icon: Radio },
  { href: "/runtime", label: "Runtime health", icon: Activity },
  { href: "/diagnostics/runtime", label: "Runtime perf", icon: FlaskConical },
] as const;

export function TopNav() {
  const pathname = usePathname();
  const { mode, exitSession, refresh } = useTradingMode();
  const [pending, setPending] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const [logOffBusy, setLogOffBusy] = useState(false);
  const [resetBusy, setResetBusy] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement | null>(null);

  const active = pending ?? pathname;
  useEffect(() => {
    setPending(null);
    setMoreOpen(false);
    setMobileOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!moreOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) setMoreOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [moreOpen]);

  const isActive = (href: string) =>
    active === href ||
    active.startsWith(`${href}/`) ||
    (href === "/mission" && active.startsWith("/token/"));

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

  const go = (href: string) => startTransition(() => setPending(href));
  const inSession = mode === "demo" || mode === "real";

  return (
    <header className="sticky top-0 z-40 border-b border-border bg-panel/95 backdrop-blur-sm">
      <div className="flex min-h-14 flex-wrap items-center gap-2 px-3 py-2 lg:gap-3 lg:px-5">
        <Link href="/trade" prefetch={false} className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-500">
            <span className="text-sm font-bold text-black">P</span>
          </div>
          <span className="hidden text-base font-bold tracking-tight text-fg sm:inline">
            Pump<span className="text-accent">Radar</span>
          </span>
        </Link>

        <nav className="ml-2 hidden items-center gap-1 md:flex">
          {PRIMARY_NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              prefetch={false}
              onClick={() => go(item.href)}
              className={`tab ${isActive(item.href) ? "tab-active" : ""}`}
            >
              {item.label}
            </Link>
          ))}
          <div className="relative" ref={moreRef}>
            <button
              type="button"
              onClick={() => setMoreOpen((o) => !o)}
              className={`tab ${
                ADVANCED_NAV.some((a) => isActive(a.href)) || OPERATOR_NAV.some((a) => isActive(a.href))
                  ? "tab-active"
                  : ""
              }`}
            >
              More <ChevronDown className="h-3.5 w-3.5" />
            </button>
            {moreOpen && (
              <div className="absolute left-0 top-full z-50 mt-1 w-52 rounded-lg border border-border bg-panel2 p-1 shadow-xl">
                {ADVANCED_NAV.map((item) => {
                  const Icon = item.icon;
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      prefetch={false}
                      onClick={() => go(item.href)}
                      className={`flex items-center gap-2 rounded-md px-2.5 py-2 text-sm ${
                        isActive(item.href) ? "text-accent" : "text-muted hover:bg-panel hover:text-fg"
                      }`}
                    >
                      <Icon className="h-4 w-4" />
                      {item.label}
                    </Link>
                  );
                })}
                <div className="my-1 border-t border-border/60 px-2.5 pb-0.5 pt-1.5 text-[10px] uppercase tracking-wide text-muted">
                  Operator
                </div>
                {OPERATOR_NAV.map((item) => {
                  const Icon = item.icon;
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      prefetch={false}
                      onClick={() => go(item.href)}
                      className={`flex items-center gap-2 rounded-md px-2.5 py-2 text-sm ${
                        isActive(item.href) ? "text-accent" : "text-muted hover:bg-panel hover:text-fg"
                      }`}
                    >
                      <Icon className="h-4 w-4" />
                      {item.label}
                    </Link>
                  );
                })}
              </div>
            )}
          </div>
        </nav>

        <div className="ml-auto flex min-w-0 max-w-full flex-1 basis-full items-center justify-end gap-1.5 overflow-x-auto text-xs sm:basis-auto sm:flex-initial sm:flex-wrap sm:overflow-visible sm:gap-2">
          {inSession && (
            <span
              className={`shrink-0 rounded-md px-2 py-1 font-semibold ${
                mode === "demo" ? "bg-accent/15 text-accent" : "bg-warn/15 text-warn"
              }`}
              title={
                mode === "demo"
                  ? "Demo session — play money only"
                  : "Real session — connected wallet and live execution when enabled"
              }
            >
              <span className="sm:hidden">{mode === "demo" ? "Demo" : "Real"}</span>
              <span className="hidden sm:inline">{mode === "demo" ? "Demo session" : "Real session"}</span>
            </span>
          )}
          <span className="hidden shrink-0 md:inline">
            <ModeGlossary />
          </span>
          <NotificationsBell
            deferMs={pathname.startsWith("/trade") ? 45_000 : 0}
            pollClosedMs={pathname.startsWith("/trade") ? 120_000 : 45_000}
          />
          <HaltButton />
          {mode === "demo" && (
            <button
              type="button"
              onClick={() => void resetDemo()}
              disabled={resetBusy}
              className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-border px-2 py-1 text-muted transition-colors hover:bg-panel2 hover:text-fg"
              title="Reset the demo account to a fresh start (keeps system learning)"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              <span className="sr-only sm:not-sr-only sm:inline">{resetBusy ? "…" : "Reset"}</span>
            </button>
          )}
          {inSession && (
            <button
              type="button"
              onClick={() => void logOff()}
              disabled={logOffBusy}
              className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-border px-2 py-1 text-muted transition-colors hover:bg-panel2 hover:text-fg"
              title="End this session and return to the home wallet chooser"
            >
              <LogOut className="h-3.5 w-3.5" />
              <span className="sr-only sm:not-sr-only sm:inline">{logOffBusy ? "…" : "Log off"}</span>
            </button>
          )}
          <button
            type="button"
            onClick={() => setMobileOpen((o) => !o)}
            className="rounded-lg p-2 text-muted hover:bg-panel2 hover:text-fg md:hidden"
            aria-label="Toggle menu"
          >
            {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>
      </div>

      {mobileOpen && (
        <div className="border-t border-border bg-panel2 px-2 py-2 md:hidden">
          {inSession && (
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-panel px-3 py-2 text-xs">
              <span className="font-semibold text-fg">
                {mode === "demo" ? "Demo session" : "Real session"}
              </span>
              <div className="flex items-center gap-2">
                {mode === "demo" && (
                  <button
                    type="button"
                    onClick={() => void resetDemo()}
                    disabled={resetBusy}
                    className="inline-flex items-center gap-1 rounded border border-border px-2 py-1"
                  >
                    <RotateCcw className="h-3 w-3" />
                    {resetBusy ? "…" : "Reset"}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => void logOff()}
                  disabled={logOffBusy}
                  className="inline-flex items-center gap-1 rounded border border-border px-2 py-1"
                >
                  <LogOut className="h-3 w-3" />
                  Log off
                </button>
              </div>
            </div>
          )}
          <div className="grid grid-cols-2 gap-1 sm:grid-cols-3">
            {[...PRIMARY_NAV, ...ADVANCED_NAV, ...OPERATOR_NAV].map((item) => (
              <Link
                key={item.href}
                href={item.href}
                prefetch={false}
                onClick={() => go(item.href)}
                className={`rounded-md px-3 py-2 text-sm ${
                  isActive(item.href) ? "bg-accent/15 text-accent" : "text-muted hover:bg-panel hover:text-fg"
                }`}
              >
                {item.label}
              </Link>
            ))}
          </div>
        </div>
      )}
    </header>
  );
}
