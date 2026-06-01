"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, useTransition, type ReactNode } from "react";
import {
  Activity,
  BarChart3,
  Bell,
  Brain,
  FlaskConical,
  LineChart,
  Menu,
  Radio,
  Settings2,
  Wallet,
  X,
  Zap,
} from "lucide-react";
import { useTradingMode } from "@/components/TradingModeProvider";
import { submitDemoReset } from "@/lib/trade-client";

const WorkersStatusBanner = dynamic(
  () =>
    import("@/components/WorkersStatusBanner").then((m) => ({
      default: m.WorkersStatusBanner,
    })),
  { ssr: false },
);
const WalletPanel = dynamic(
  () => import("@/components/WalletPanel").then((m) => ({ default: m.WalletPanel })),
  { ssr: false, loading: () => <span className="pill text-muted">wallet…</span> },
);
const NotificationsBell = dynamic(
  () =>
    import("@/components/NotificationsBell").then((m) => ({
      default: m.NotificationsBell,
    })),
  { ssr: false },
);
const HaltButton = dynamic(
  () => import("@/components/HaltButton").then((m) => ({ default: m.HaltButton })),
  { ssr: false },
);
const RealModeGate = dynamic(
  () => import("@/components/RealModeGate").then((m) => ({ default: m.RealModeGate })),
  { ssr: false },
);

const PRIMARY_NAV = [
  { href: "/mission", label: "Mission control", icon: Zap, hint: "Radar" },
  { href: "/trade", label: "Trade", icon: Activity },
  { href: "/market", label: "Market", icon: Radio },
  { href: "/signals", label: "Signals", icon: Zap },
  { href: "/holdings", label: "Holdings", icon: Wallet },
] as const;

const ADVANCED_NAV = [
  { href: "/analytics", label: "Analytics", icon: BarChart3, hint: "PnL" },
  { href: "/smart-money", label: "Smart money", icon: LineChart, hint: "Wallets" },
  { href: "/rings", label: "Wallet rings", icon: Radio, hint: "Clusters" },
  { href: "/learning", label: "Learning", icon: Brain, hint: "Rules" },
  { href: "/backtest", label: "Backtest", icon: FlaskConical, hint: "Sim" },
  { href: "/notifications", label: "Notifications", icon: Bell, hint: "Alerts" },
  { href: "/runtime", label: "Runtime health", icon: Activity, hint: "Workers" },
  { href: "/diagnostics/runtime", label: "Runtime perf", icon: FlaskConical, hint: "Speed" },
] as const;

export function PortalLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const { mode, demo, setMode, refresh } = useTradingMode();
  const [resetBusy, setResetBusy] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [realGateOpen, setRealGateOpen] = useState(false);

  const active = pending ?? pathname;

  useEffect(() => {
    setPending(null);
  }, [pathname]);

  async function resetDemoWallet() {
    if (
      !window.confirm(
        "Queue demo wallet reset? The worker will close open demo positions and restore starting balance.",
      )
    ) {
      return;
    }
    setResetBusy(true);
    try {
      const res = await submitDemoReset();
      if (!res.ok) {
        window.alert(res.error ?? "Demo reset failed");
        return;
      }
      await refresh();
    } finally {
      setResetBusy(false);
    }
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <WorkersStatusBanner deferMs={pathname.startsWith("/trade") ? 60_000 : 0} />
      <RealModeGate
        open={realGateOpen}
        onCancel={() => setRealGateOpen(false)}
        onConfirm={() => {
          setRealGateOpen(false);
          void setMode("real");
        }}
      />
      <header className="sticky top-0 z-40 border-b border-gray-200 bg-white/95 backdrop-blur-sm">
        <div className="flex h-14 items-center justify-between gap-3 px-4 lg:px-6">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setSidebarOpen((o) => !o)}
              className="rounded-lg p-2 hover:bg-gray-100 lg:hidden"
              aria-label="Toggle menu"
            >
              {sidebarOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
            </button>
            <Link href="/terminal" className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-500">
                <span className="text-sm font-bold text-white">P</span>
              </div>
              <span className="hidden text-lg font-bold text-brand-600 sm:inline">Pump Radar</span>
            </Link>
            <span className="hidden rounded-full bg-gray-100 px-3 py-0.5 text-xs text-gray-500 md:inline">
              Trading portal
            </span>
          </div>

          <div className="flex flex-wrap items-center justify-end gap-2 text-xs">
            <div className="flex rounded-lg border border-gray-200 p-0.5">
              <button
                type="button"
                onClick={() => setMode("demo")}
                className={`rounded-md px-2.5 py-1 ${
                  mode === "demo" ? "bg-emerald-50 font-medium text-emerald-700" : "text-gray-500"
                }`}
              >
                Demo
              </button>
              <button
                type="button"
                onClick={() => {
                  if (mode !== "real") setRealGateOpen(true);
                }}
                className={`rounded-md px-2.5 py-1 ${
                  mode === "real" ? "bg-amber-50 font-medium text-amber-700" : "text-gray-500"
                }`}
              >
                Real
              </button>
            </div>
            {mode === "demo" && demo && (
              <span className="flex items-center gap-1.5 font-mono text-gray-500">
                <span
                  title={`Equity ${demo.equitySol.toFixed(4)} · cash ${demo.balanceSol.toFixed(4)} · locked ${demo.lockedSol.toFixed(4)} · unrealized ${demo.unrealizedPnlSol >= 0 ? "+" : ""}${demo.unrealizedPnlSol.toFixed(4)}`}
                >
                  {(demo.equitySol ?? demo.balanceSol).toFixed(4)} SOL
                  {demo.openPositions > 0 && demo.lockedSol > 0 && (
                    <span className="ml-1 text-[10px] text-gray-400">
                      ({demo.balanceSol.toFixed(2)} free)
                    </span>
                  )}
                </span>
                <button
                  type="button"
                  onClick={() => void resetDemoWallet()}
                  disabled={resetBusy}
                  className="rounded border border-gray-200 px-1.5 py-0.5 text-[10px] text-gray-500 hover:bg-gray-50"
                  title="Queue demo reset (worker closes positions, restores balance)"
                >
                  {resetBusy ? "…" : "Reset"}
                </button>
              </span>
            )}
            <NotificationsBell
              deferMs={pathname.startsWith("/trade") ? 45_000 : 0}
              pollClosedMs={pathname.startsWith("/trade") ? 120_000 : 45_000}
            />
            <HaltButton />
            <WalletPanel />
          </div>
        </div>
      </header>

      <div className="flex">
        <aside
          className={`fixed inset-y-0 left-0 z-30 mt-14 w-64 transform border-r border-gray-200 bg-white transition-transform duration-200 lg:static lg:mt-0 lg:translate-x-0 ${
            sidebarOpen ? "translate-x-0" : "-translate-x-full"
          }`}
        >
          <nav className="space-y-1 p-3">
            {PRIMARY_NAV.map((item) => {
              const Icon = item.icon;
              const isActive =
                active === item.href ||
                active.startsWith(`${item.href}/`) ||
                (item.href === "/mission" && active.startsWith("/token/"));
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  prefetch={false}
                  onClick={() => {
                    setSidebarOpen(false);
                    startTransition(() => setPending(item.href));
                  }}
                  className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors ${
                    isActive
                      ? "bg-brand-50 font-medium text-brand-700 shadow-sm"
                      : "text-gray-700 hover:bg-gray-50 hover:text-gray-900"
                  }`}
                >
                  <Icon className={`h-5 w-5 ${isActive ? "text-brand-500" : "text-gray-400"}`} />
                  <span className="flex-1">{item.label}</span>
                  {"hint" in item && item.hint && (
                    <span className="rounded bg-ok/15 px-1.5 py-0.5 text-[9px] font-medium text-ok">
                      {item.hint}
                    </span>
                  )}
                </Link>
              );
            })}
            <button
              type="button"
              onClick={() => setShowAdvanced((v) => !v)}
              className="mt-2 flex w-full items-center gap-3 rounded-lg px-3 py-2 text-xs text-gray-500 hover:bg-gray-50"
            >
              {showAdvanced ? "Hide advanced" : "Show advanced"}
            </button>
            {showAdvanced &&
              ADVANCED_NAV.map((item) => {
                const Icon = item.icon;
                const isActive = active === item.href || active.startsWith(`${item.href}/`);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    prefetch={false}
                    onClick={() => {
                      setSidebarOpen(false);
                      startTransition(() => setPending(item.href));
                    }}
                    className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors ${
                      isActive
                        ? "bg-brand-50 font-medium text-brand-700 shadow-sm"
                        : "text-gray-600 hover:bg-gray-50 hover:text-gray-900"
                    }`}
                  >
                    <Icon className={`h-5 w-5 ${isActive ? "text-brand-500" : "text-gray-400"}`} />
                    <span className="flex-1">{item.label}</span>
                    {"hint" in item && item.hint && (
                      <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[9px] font-medium text-gray-500">
                        {item.hint}
                      </span>
                    )}
                  </Link>
                );
              })}
            <Link
              href="/"
              className="mt-4 flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm text-gray-500 hover:bg-gray-50"
            >
              <Settings2 className="h-5 w-5 text-gray-400" />
              Home
            </Link>
          </nav>
        </aside>

        <main className="min-h-[calc(100vh-3.5rem)] flex-1 p-4 lg:p-6">{children}</main>
      </div>

      {sidebarOpen && (
        <button
          type="button"
          className="fixed inset-0 z-20 bg-black/40 lg:hidden"
          aria-label="Close menu"
          onClick={() => setSidebarOpen(false)}
        />
      )}
    </div>
  );
}
