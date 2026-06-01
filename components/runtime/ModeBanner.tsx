"use client";

import { useEffect, useState } from "react";

type Health = {
  runtimeProfile: "paper_safe" | "dev" | "live";
  traderMode: "paper" | "devnet" | "live";
  uiTradingMode: "demo" | "real" | null;
  workerAlive: boolean;
  workersExpected: boolean;
  liveExecution: "on" | "off";
  liveDryRun: "on" | "off";
  circuitBreaker: string | null;
  ingest: { ingestStaleSec: number | null; drops1h: number };
};

const toneFor = (h: Health): { color: string; label: string } => {
  if (h.runtimeProfile === "live" && h.liveExecution === "on" && h.liveDryRun !== "on") {
    return { color: "bg-red-700/30 text-red-200 border-red-700/40", label: "LIVE · REAL MONEY" };
  }
  if (h.runtimeProfile === "live") {
    return { color: "bg-amber-700/30 text-amber-200 border-amber-700/40", label: "LIVE PROFILE · dry-run" };
  }
  if (h.runtimeProfile === "dev") {
    return { color: "bg-sky-700/30 text-sky-200 border-sky-700/40", label: "DEVNET" };
  }
  return { color: "bg-emerald-700/30 text-emerald-200 border-emerald-700/40", label: "PAPER · safe" };
};

/**
 * Always-visible runtime banner. Source of truth: /api/runtime/health (Postgres).
 */
export function ModeBanner() {
  const [h, setH] = useState<Health | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetch("/api/runtime/health", { cache: "no-store" });
        if (!r.ok) return;
        const j = (await r.json()) as Health;
        if (!cancelled) setH(j);
      } catch {
        /* keep last known state */
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

  const tone = toneFor(h);
  const workerOk = h.workerAlive;
  const stale = h.ingest.ingestStaleSec != null && h.ingest.ingestStaleSec > 30;
  const uiLabel =
    h.uiTradingMode === "real" ? "UI: Real wallet" : h.uiTradingMode === "demo" ? "UI: Demo" : "UI: —";

  return (
    <div className={`flex flex-wrap items-center justify-center gap-3 border-b px-3 py-1 text-[11px] font-mono ${tone.color}`}>
      <span className="font-semibold">{tone.label}</span>
      <span className="opacity-70">·</span>
      <span>{uiLabel}</span>
      {h.liveDryRun === "on" && h.liveExecution === "on" && (
        <>
          <span className="opacity-70">·</span>
          <span className="text-amber-200">live dry-run</span>
        </>
      )}
      {h.circuitBreaker === "HALTED" && (
        <>
          <span className="opacity-70">·</span>
          <span className="text-red-300">HALTED</span>
        </>
      )}
      <span className="opacity-70">·</span>
      <span>
        worker:{" "}
        <span className={workerOk ? "text-emerald-300" : "text-red-300"}>
          {workerOk ? "alive" : h.workersExpected ? "DOWN" : "off"}
        </span>
      </span>
      <span className="opacity-70">·</span>
      <span>
        ingest:{" "}
        <span className={stale ? "text-amber-300" : "text-emerald-300"}>
          {h.ingest.ingestStaleSec == null ? "no data" : `${h.ingest.ingestStaleSec}s stale`}
        </span>
      </span>
      {h.ingest.drops1h > 0 && (
        <>
          <span className="opacity-70">·</span>
          <span className="text-amber-300">drops/1h: {h.ingest.drops1h}</span>
        </>
      )}
    </div>
  );
}
