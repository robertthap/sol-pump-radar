"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import {
  Activity,
  BarChart3,
  FlaskConical,
  LayoutDashboard,
  Radar,
  Zap,
} from "lucide-react";
import { MissionControlProvider, useMissionControl } from "@/lib/mission/MissionControlProvider";
import { MomentumArena } from "@/components/mission/MomentumArena";
import { RankVelocityChart } from "@/components/mission/RankVelocityChart";
import { EventHeartbeat } from "@/components/mission/EventHeartbeat";
import { EngineHeatmap } from "@/components/mission/EngineHeatmap";
import { AutoTradeSafetyPanel } from "@/components/mission/AutoTradeSafetyPanel";
import { WhyMissedPanel } from "@/components/mission/WhyMissedPanel";
import { TokenIntelligenceDrawer } from "@/components/mission/TokenIntelligenceDrawer";
import { MissionTerminal } from "@/components/mission/MissionTerminal";

const RAIL = [
  { href: "/mission", label: "Mission control", icon: Radar },
  { href: "/signals", label: "Signals", icon: Zap },
  { href: "/trade", label: "Trade", icon: Activity },
  { href: "/market", label: "Market", icon: LayoutDashboard },
  { href: "/backtest", label: "Backtest", icon: FlaskConical },
] as const;

function StatChip({ label, value, tone }: { label: string; value: ReactNode; tone?: string }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 px-2.5 py-1.5 text-center">
      <dt className="text-[9px] uppercase tracking-wide text-zinc-500">{label}</dt>
      <dd className={`font-mono text-sm font-semibold ${tone ?? "text-zinc-200"}`}>{value}</dd>
    </div>
  );
}

function MissionTopBar() {
  const { data } = useMissionControl();
  const intel = data?.intelligence;
  const workersOn = data?.workers === "on";
  return (
    <header className="relative z-10 flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800/80 bg-zinc-950/70 px-4 py-3 backdrop-blur-md">
      <div className="flex items-center gap-3">
        <Link href="/" className="flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand-500 shadow-lg shadow-brand-500/20">
            <span className="text-base font-bold text-black">P</span>
          </span>
          <span className="text-lg font-bold tracking-tight text-zinc-100">
            Pump<span className="text-accent">Radar</span>
          </span>
        </Link>
        <span className="hidden items-center gap-1.5 rounded-full border border-zinc-800 bg-zinc-900/60 px-2.5 py-1 text-[10px] font-medium text-zinc-400 sm:flex">
          <Radar className="h-3 w-3 text-cyan-400" />
          Mission Control
        </span>
      </div>
      <dl className="flex flex-wrap items-stretch gap-2">
        <StatChip label="Universe" value={data?.stats.total ?? 0} tone="text-cyan-400" />
        <StatChip label="Commits/h" value={intel?.commits_last_hour ?? 0} />
        <StatChip label="Auto-eligible/h" value={intel?.auto_eligible_last_hour ?? 0} tone="text-emerald-400" />
        <StatChip
          label="Workers"
          tone={workersOn ? "text-emerald-400" : "text-amber-400"}
          value={
            <span className="flex items-center justify-center gap-1">
              <span className={`inline-block h-1.5 w-1.5 rounded-full ${workersOn ? "animate-pulse bg-emerald-400" : "bg-amber-400"}`} />
              {data?.workers ?? "?"}
            </span>
          }
        />
      </dl>
    </header>
  );
}

function MissionBody() {
  return (
    <div className="mission-shell relative flex min-h-[calc(100vh-3.5rem)] flex-col overflow-hidden">
      {/* ambient glow — echoes the home page */}
      <div
        className="pointer-events-none absolute inset-0 z-0"
        style={{
          background: "radial-gradient(70% 40% at 50% 0%, rgb(22 199 132 / 0.08), transparent 70%)",
        }}
      />
      <MissionTopBar />
      <div className="relative z-10 flex flex-1 flex-col lg:flex-row">
        <nav className="flex shrink-0 gap-1 overflow-x-auto border-b border-zinc-800 bg-zinc-950 px-2 py-2 lg:w-44 lg:flex-col lg:border-b-0 lg:border-r">
          {RAIL.map((item) => {
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex items-center gap-2 rounded-md px-3 py-2 text-xs whitespace-nowrap ${
                  item.href === "/mission"
                    ? "bg-cyan-500/15 text-cyan-300"
                    : "text-zinc-500 hover:bg-zinc-800/60 hover:text-zinc-200"
                }`}
              >
                <Icon className="h-4 w-4 shrink-0" />
                {item.label}
              </Link>
            );
          })}
          <Link
            href="/analytics"
            className="flex items-center gap-2 rounded-md px-3 py-2 text-xs text-zinc-600 hover:text-zinc-400"
          >
            <BarChart3 className="h-4 w-4" />
            Analytics
          </Link>
        </nav>

        <div className="flex flex-1 flex-col overflow-hidden">
          <div className="grid flex-1 gap-3 overflow-y-auto p-3 xl:grid-cols-12">
            <div className="space-y-3 xl:col-span-7">
              <MomentumArena />
              <div className="grid gap-3 md:grid-cols-2">
                <RankVelocityChart />
                <EventHeartbeat />
              </div>
              <TokenIntelligenceDrawer />
            </div>
            <div className="space-y-3 xl:col-span-5">
              <EngineHeatmap />
              <AutoTradeSafetyPanel />
              <WhyMissedPanel />
            </div>
          </div>
          <MissionTerminal />
        </div>
      </div>
    </div>
  );
}

export function MissionControlShell() {
  return (
    <MissionControlProvider>
      <MissionBody />
    </MissionControlProvider>
  );
}
