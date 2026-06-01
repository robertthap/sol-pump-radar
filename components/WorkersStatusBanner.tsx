"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useVisibleInterval } from "@/lib/ui/useVisibleInterval";

type HeartbeatRow = { name: string; healthy: boolean; staleMs: number };

type RuntimeHealth = {
  workersExpected: boolean;
  workerAlive: boolean;
  heartbeats: HeartbeatRow[];
  ingest?: { ingestStaleSec: number | null };
  rpc?: { rpcScore: number; rpcIssues: string[] };
};

const CRITICAL = ["ingestor", "analytics", "intelligence-commit", "auto-trader"];

export function WorkersStatusBanner({ deferMs = 0 }: { deferMs?: number }) {
  const [health, setHealth] = useState<RuntimeHealth | null>(null);
  const workersOnSince = useRef<number | null>(null);
  const [ready, setReady] = useState(deferMs <= 0);

  useEffect(() => {
    if (deferMs <= 0) return;
    const t = window.setTimeout(() => setReady(true), deferMs);
    return () => window.clearTimeout(t);
  }, [deferMs]);

  const load = useCallback(async () => {
    if (!ready) return;
    try {
      const r = await fetch("/api/runtime/health", { cache: "no-store" });
      if (!r.ok) return;
      const data = (await r.json()) as RuntimeHealth;
      if (data.workersExpected && workersOnSince.current == null) {
        workersOnSince.current = Date.now();
      }
      setHealth(data);
    } catch {
      /* ignore */
    }
  }, [ready]);

  useVisibleInterval(load, ready ? 30_000 : 0, [load, ready]);

  if (!health) return null;

  if (!health.workersExpected) {
    return (
      <div className="border-b border-bad/40 bg-bad/10 px-3 py-1.5 text-center text-[11px] text-bad">
        WORKERS=off in .env.local — set WORKERS=on and restart `pnpm dev`, and make sure `pnpm worker` is running.
      </div>
    );
  }

  const now = Date.now();
  const bootGraceMs = 57_000;
  const inBootGrace =
    workersOnSince.current != null && now - workersOnSince.current < bootGraceMs;

  const stale = CRITICAL.filter((name) => {
    const row = health.heartbeats.find((h) => h.name === name);
    return !row?.healthy;
  });

  if (inBootGrace && stale.length > 0) {
    return (
      <div className="border-b border-border/60 bg-panel/40 px-3 py-1.5 text-center text-[11px] text-muted">
        Workers starting — UI loads first, then ingest & intelligence
      </div>
    );
  }

  if (!health.workerAlive && stale.length > 0) {
    return (
      <div className="border-b border-warn/40 bg-warn/10 px-3 py-1.5 text-center text-[11px] text-warn">
        Worker not healthy — stale: {stale.join(", ")} — run `pnpm worker` and check logs
      </div>
    );
  }

  if (stale.length === 0) return null;

  return (
    <div className="border-b border-warn/40 bg-warn/10 px-3 py-1.5 text-center text-[11px] text-warn">
      Workers on but stale: {stale.join(", ")} — check Output for errors or Shift+F5
    </div>
  );
}
