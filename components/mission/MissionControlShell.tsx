"use client";

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
  { href: "/signals", label: "Signals log", icon: Zap },
  { href: "/trade", label: "Auto trade", icon: Activity },
  { href: "/market", label: "Market trenches", icon: LayoutDashboard },
  { href: "/backtest", label: "Replay", icon: FlaskConical },
] as const;

function MissionTopBar() {
  const { data } = useMissionControl();
  const intel = data?.intelligence;
  return (
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800 bg-zinc-950/90 px-4 py-3">
      <div>
        <h1 className="text-sm font-bold tracking-wide text-zinc-100">PUMP RADAR · MISSION CONTROL</h1>
        <p className="text-[10px] text-zinc-500">
          What is moving · Why · How early · Should we trade · Why we skipped
        </p>
      </div>
      <dl className="flex flex-wrap gap-4 text-[10px] font-mono">
        <div>
          <dt className="text-zinc-600">Universe</dt>
          <dd className="text-cyan-400">{data?.stats.total ?? 0}</dd>
        </div>
        <div>
          <dt className="text-zinc-600">Commits/h</dt>
          <dd className="text-zinc-200">{intel?.commits_last_hour ?? 0}</dd>
        </div>
        <div>
          <dt className="text-zinc-600">Auto-eligible/h</dt>
          <dd className="text-emerald-400">{intel?.auto_eligible_last_hour ?? 0}</dd>
        </div>
        <div>
          <dt className="text-zinc-600">Workers</dt>
          <dd className={data?.workers === "on" ? "text-emerald-400" : "text-amber-400"}>
            {data?.workers ?? "?"}
          </dd>
        </div>
      </dl>
    </header>
  );
}

function MissionBody() {
  return (
    <div className="mission-shell flex min-h-[calc(100vh-3.5rem)] flex-col">
      <MissionTopBar />
      <div className="flex flex-1 flex-col lg:flex-row">
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
