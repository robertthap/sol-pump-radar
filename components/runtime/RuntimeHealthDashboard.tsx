"use client";

import { useEffect, useState } from "react";

type Heartbeat = {
  name: string;
  lastBeat: string;
  tickMs: number | null;
  staleMs: number;
  healthy: boolean;
};

type Health = {
  runtimeProfile: "paper_safe" | "dev" | "live";
  workersExpected: boolean;
  workerAlive: boolean;
  liveExecution: "on" | "off";
  liveDryRun: "on" | "off";
  traderMode: string;
  uiTradingMode: "demo" | "real" | null;
  circuitBreaker: string | null;
  heartbeats: Heartbeat[];
  ingest: {
    lastEventAt: string | null;
    eventsLast60s: number;
    ingestStaleSec: number | null;
    drops1h: number;
    dropBatches1h: number;
    maxQueue: number;
  };
  snapshot: { rpc?: { rpcScore?: number; rpcIssues?: string[]; latencyMs?: number | null } } | null;
  snapshotSparkline: Array<{ at: string; rpcScore: number | null; openPaper: number | null }>;
  rpc: { rpcScore?: number; rpcIssues?: string[]; latencyMs?: number | null } | null;
  lastDomainEventAt: string | null;
  heartbeatTimeoutMs: number;
  now: string;
};

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

export function RuntimeHealthDashboard() {
  const [h, setH] = useState<Health | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const r = await fetch("/api/runtime/health", { cache: "no-store" });
        if (!r.ok) {
          setErr(`HTTP ${r.status}`);
          return;
        }
        const j = (await r.json()) as Health;
        if (!stop) {
          setH(j);
          setErr(null);
        }
      } catch (e) {
        setErr(String(e));
      }
    };
    void tick();
    const id = setInterval(() => void tick(), 3000);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, []);

  if (err && !h) {
    return <div className="rounded border border-bad/40 bg-bad/10 p-3 text-sm text-bad">{err}</div>;
  }
  if (!h) return <div className="text-sm text-muted">loading…</div>;

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Runtime health</h1>
        <p className="mt-1 text-xs text-muted">
          Truth source: Postgres (worker_heartbeat, events, domain_events). Refreshed every 3s.
        </p>
      </header>

      <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Runtime profile" value={h.runtimeProfile.toUpperCase()} tone={h.runtimeProfile === "paper_safe" ? "good" : h.runtimeProfile === "dev" ? "info" : "warn"} />
        <Stat label="Workers expected" value={h.workersExpected ? "yes" : "no"} />
        <Stat label="Worker alive" value={h.workerAlive ? "yes" : "NO"} tone={h.workerAlive ? "good" : "bad"} />
        <Stat
          label="Live execution"
          value={h.liveExecution.toUpperCase()}
          tone={h.liveExecution === "on" && h.liveDryRun !== "on" ? "bad" : "neutral"}
          hint={h.liveDryRun === "on" ? "dry-run" : "REAL MONEY"}
        />
      </section>

      <section className="rounded border border-border bg-panel/50">
        <header className="border-b border-border px-3 py-2 text-sm font-medium">
          Worker heartbeats ({h.heartbeats.length})
        </header>
        {h.heartbeats.length === 0 ? (
          <div className="px-3 py-6 text-center text-sm text-muted">
            No heartbeats yet. Run <code>pnpm worker</code> in a second terminal.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wider text-muted">
              <tr>
                <th className="px-3 py-2">Worker</th>
                <th className="px-3 py-2 text-right">Last beat</th>
                <th className="px-3 py-2 text-right">Tick</th>
                <th className="px-3 py-2 text-right">Status</th>
              </tr>
            </thead>
            <tbody>
              {h.heartbeats.map((b) => (
                <tr key={b.name} className="border-t border-border/60">
                  <td className="px-3 py-2 font-mono text-xs">{b.name}</td>
                  <td className="px-3 py-2 text-right text-xs">{fmtMs(b.staleMs)} ago</td>
                  <td className="px-3 py-2 text-right text-xs text-muted">
                    {b.tickMs != null ? fmtMs(b.tickMs) : "—"}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <span
                      className={`rounded px-2 py-0.5 text-[10px] font-medium ${
                        b.healthy ? "bg-emerald-700/20 text-emerald-300" : "bg-red-700/20 text-red-300"
                      }`}
                    >
                      {b.healthy ? "healthy" : "STALE"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {h.rpc && (
        <section className="rounded border border-border bg-panel/50 p-4">
          <h2 className="text-sm font-medium">RPC health</h2>
          <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat
              label="RPC score"
              value={h.rpc.rpcScore != null ? String(h.rpc.rpcScore) : "—"}
              tone={
                h.rpc.rpcScore == null
                  ? "neutral"
                  : h.rpc.rpcScore >= 70
                    ? "good"
                    : h.rpc.rpcScore >= 40
                      ? "warn"
                      : "bad"
              }
            />
            <Stat
              label="HTTP latency"
              value={h.rpc.latencyMs != null ? `${h.rpc.latencyMs}ms` : "—"}
              tone={h.rpc.latencyMs != null && h.rpc.latencyMs > 800 ? "warn" : "good"}
            />
            <Stat
              label="UI mode"
              value={h.uiTradingMode ?? "—"}
              hint={h.circuitBreaker === "HALTED" ? "circuit HALTED" : undefined}
              tone={h.circuitBreaker === "HALTED" ? "bad" : "neutral"}
            />
            <Stat
              label="RPC issues"
              value={h.rpc.rpcIssues?.length ? String(h.rpc.rpcIssues.length) : "0"}
              hint={h.rpc.rpcIssues?.join(", ")}
              tone={h.rpc.rpcIssues?.length ? "warn" : "good"}
            />
          </div>
          {h.snapshotSparkline.length > 1 && (
            <div className="mt-4">
              <div className="text-[11px] uppercase tracking-wider text-muted">RPC score (24h)</div>
              <div className="mt-2 flex h-10 items-end gap-px">
                {h.snapshotSparkline.map((p) => {
                  const score = p.rpcScore ?? 0;
                  const hPct = Math.max(4, Math.min(100, score));
                  return (
                    <div
                      key={p.at}
                      title={`${p.at}: score ${score}`}
                      className="flex-1 rounded-t bg-accent/40"
                      style={{ height: `${hPct}%` }}
                    />
                  );
                })}
              </div>
            </div>
          )}
        </section>
      )}

      <section className="rounded border border-border bg-panel/50 p-4">
        <h2 className="text-sm font-medium">Ingest pipeline</h2>
        <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat
            label="Last event"
            value={h.ingest.ingestStaleSec == null ? "—" : `${h.ingest.ingestStaleSec}s ago`}
            tone={h.ingest.ingestStaleSec == null ? "neutral" : h.ingest.ingestStaleSec > 30 ? "warn" : "good"}
          />
          <Stat label="Events / 60s" value={String(h.ingest.eventsLast60s)} />
          <Stat
            label="Drops / 1h"
            value={String(h.ingest.drops1h)}
            tone={h.ingest.drops1h > 0 ? "warn" : "good"}
            hint={`${h.ingest.dropBatches1h} batches`}
          />
          <Stat label="Max queue" value={String(h.ingest.maxQueue)} hint="MAX_INGEST_QUEUE" />
        </div>
      </section>
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
  tone = "neutral",
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "good" | "bad" | "warn" | "info" | "neutral";
}) {
  const toneClass =
    tone === "good"
      ? "text-emerald-300"
      : tone === "bad"
        ? "text-red-300"
        : tone === "warn"
          ? "text-amber-300"
          : tone === "info"
            ? "text-sky-300"
            : "text-fg";
  return (
    <div className="rounded border border-border bg-panel/40 p-3">
      <div className="text-[11px] uppercase tracking-wider text-muted">{label}</div>
      <div className={`mt-1 font-mono text-lg ${toneClass}`}>{value}</div>
      {hint && <div className="mt-0.5 text-[10px] text-muted">{hint}</div>}
    </div>
  );
}
