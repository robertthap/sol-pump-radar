"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { getJson } from "@/lib/ui/client-get";
import { useDeferReady } from "@/lib/ui/useDeferReady";
import { useVisibleInterval } from "@/lib/ui/useVisibleInterval";
import type { ConsolePayload } from "@/lib/mission/types";

type MissionCtx = {
  data: ConsolePayload | null;
  loading: boolean;
  selectedMint: string | null;
  setSelectedMint: (mint: string | null) => void;
  refresh: () => Promise<void>;
};

const Ctx = createContext<MissionCtx | null>(null);

export function useMissionControl() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useMissionControl requires MissionControlProvider");
  return v;
}

function mergeConsole(base: ConsolePayload, extra: ConsolePayload): ConsolePayload {
  return {
    ...extra,
    arena: extra.arena.length ? extra.arena : base.arena,
    heatmap: extra.heatmap.length ? extra.heatmap : base.heatmap,
    stats: extra.stats?.total ? extra.stats : base.stats,
    intelligence: extra.intelligence ?? base.intelligence,
    events: extra.events.length ? extra.events : base.events,
    recentCommits: extra.recentCommits.length ? extra.recentCommits : base.recentCommits,
    rankSeries: extra.rankSeries.length ? extra.rankSeries : base.rankSeries,
    workerHeartbeats: extra.workerHeartbeats ?? base.workerHeartbeats,
    workerLastTickMs: extra.workerLastTickMs ?? base.workerLastTickMs,
  };
}

export function MissionControlProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<ConsolePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedMint, setSelectedMint] = useState<string | null>(null);
  const ready = useDeferReady(350);
  const fullEvery = useRef(0);

  const applyPayload = useCallback((j: ConsolePayload) => {
    setData(j);
    setSelectedMint((prev) => {
      if (prev && j.arena.some((a) => a.mint === prev)) return prev;
      return j.arena[0]?.mint ?? null;
    });
  }, []);

  const refreshLite = useCallback(async () => {
    if (!ready) return;
    const j = await getJson<ConsolePayload>("/api/intelligence/console?lite=1", 8_000);
    if (!j) return;
    setData((prev) => (prev ? mergeConsole(prev, j) : j));
    setLoading(false);
  }, [ready]);

  const refreshFull = useCallback(async () => {
    if (!ready) return;
    const j = await getJson<ConsolePayload>("/api/intelligence/console", 12_000);
    if (!j) return;
    applyPayload(j);
    setLoading(false);
  }, [ready, applyPayload]);

  const refresh = useCallback(async () => {
    await refreshLite();
    const now = Date.now();
    if (now - fullEvery.current > 60_000) {
      fullEvery.current = now;
      await refreshFull();
    }
  }, [refreshLite, refreshFull]);

  useVisibleInterval(refreshLite, ready ? 12_000 : 0, [refreshLite, ready]);
  useVisibleInterval(refreshFull, ready ? 60_000 : 0, [refreshFull, ready]);

  const value = useMemo(
    () => ({ data, loading, selectedMint, setSelectedMint, refresh: refreshFull }),
    [data, loading, selectedMint, refreshFull],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
