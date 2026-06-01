"use client";

import { useCallback, useState } from "react";
import { useVisibleInterval } from "@/lib/ui/useVisibleInterval";
import { useMissionControl } from "@/lib/mission/MissionControlProvider";
import { TokenIntelligencePanel } from "@/components/TokenIntelligencePanel";
import { IntelligenceTruthViewer } from "@/components/IntelligenceTruthViewer";
import { stateVisual } from "@/lib/ui/momentum-states";

export function TokenIntelligenceDrawer() {
  const { selectedMint, data } = useMissionControl();
  const arenaRow = data?.arena.find((a) => a.mint === selectedMint);
  const [traceMint, setTraceMint] = useState(selectedMint ?? "");

  const syncMint = useCallback(() => {
    if (selectedMint) setTraceMint(selectedMint);
  }, [selectedMint]);

  useVisibleInterval(syncMint, 1_000, [syncMint]);

  if (!selectedMint) {
    return (
      <section className="mission-panel flex min-h-[320px] items-center justify-center p-6 text-sm text-zinc-500">
        Select a token in the arena to inspect rank, traces, and gate decisions.
      </section>
    );
  }

  const vis = stateVisual(arenaRow?.state ?? "cold");

  return (
    <section className="mission-panel overflow-hidden">
      <header className="mission-panel-head flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="mission-title">{arenaRow?.symbol ?? selectedMint.slice(0, 8)}</h2>
          <span className={`font-mono text-xs font-bold ${vis.text}`}>{vis.label}</span>
        </div>
        <span className="font-mono text-[10px] text-zinc-500">
          Rank {(arenaRow?.rank_percentile ?? 0) * 100}% · v{" "}
          {((arenaRow?.rank_velocity ?? 0) * 100).toFixed(1)}%
        </span>
      </header>
      <div className="grid max-h-[520px] gap-0 overflow-y-auto lg:grid-cols-2">
        <div className="border-r border-zinc-800/80 p-2 mission-panel-invert">
          <TokenIntelligencePanel mint={selectedMint} />
        </div>
        <div className="hidden p-2 lg:block mission-panel-invert">
          <p className="mb-2 text-[10px] uppercase tracking-wider text-zinc-500">Decision timeline</p>
          {traceMint ? (
            <IntelligenceTruthViewer key={traceMint} defaultMint={traceMint} compact />
          ) : null}
        </div>
      </div>
    </section>
  );
}
