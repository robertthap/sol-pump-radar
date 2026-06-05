"use client";
import { useCallback, useState } from "react";
import { useVisibleInterval } from "@/lib/ui/useVisibleInterval";

type Cluster = {
  id: string;
  kind: string;
  memberCount: number;
  confidence: number;
  label: string | null;
  updatedAt: string;
  members: string[];
  meta: {
    edgeCount?: number;
    maxEdges?: number;
    density?: number;
    sharedMintsTotal?: number;
    bundleMints?: number;
    sniperMints?: number;
    windowHours?: number;
  } | null;
};

function relTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

function kindCls(k: string): string {
  if (k === "bundle_ring") return "border-bad/50 text-bad";
  if (k === "sniper_ring") return "border-warn/50 text-warn";
  return "border-accent/40 text-accent";
}

export function ClustersPanel() {
  const [clusters, setClusters] = useState<Cluster[]>([]);
  const [filter, setFilter] = useState<"all" | "bundle_ring" | "sniper_ring" | "co_buy">("all");
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const u = new URL("/api/clusters", window.location.origin);
      u.searchParams.set("limit", "50");
      if (filter !== "all") u.searchParams.set("kind", filter);
      const r = await fetch(u.toString(), { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as { clusters: Cluster[] };
      setClusters(j.clusters);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useVisibleInterval(() => void load(), 30_000, [load]);

  return (
    <div className="card p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold tracking-tight">Wallet rings</h2>
          <p className="text-xs text-muted">
            Wallets that consistently buy the same mints in the same launch window - likely
            coordinated. Bundle rings are highest-risk.
          </p>
        </div>
        <div className="flex items-center gap-0 rounded-md border border-border p-0.5">
          {(["all", "bundle_ring", "sniper_ring", "co_buy"] as const).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={`px-2.5 py-1 text-xs ${
                filter === f
                  ? "rounded-sm bg-accent/15 text-accent"
                  : "text-muted hover:text-fg"
              }`}
            >
              {f === "all" ? "All" : f === "bundle_ring" ? "Bundle" : f === "sniper_ring" ? "Sniper" : "Co-buy"}
            </button>
          ))}
        </div>
      </div>
      {loading && clusters.length === 0 && <div className="text-xs text-muted">loading...</div>}
      {err && <div className="text-xs text-bad">{err}</div>}
      {!loading && clusters.length === 0 && (
        <div className="rounded-md border border-border bg-bg/40 p-4 text-center text-xs text-muted">
          No rings detected yet - scanner runs every 10 minutes; first run is ~1.5 min after boot
        </div>
      )}
      <div className="space-y-2">
        {clusters.map((c) => {
          const isOpen = expanded === c.id;
          return (
            <div key={c.id} className="rounded-md border border-border bg-bg/40">
              <button
                type="button"
                onClick={() => setExpanded(isOpen ? null : c.id)}
                className="flex w-full flex-wrap items-center justify-between gap-2 px-3 py-2 text-left hover:bg-panel/5"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`pill-side ${kindCls(c.kind)}`}>{c.kind.replace("_", " ")}</span>
                  <span className="text-sm font-medium">{c.label ?? c.id}</span>
                  <span className="text-[10px] text-muted">
                    {c.memberCount} wallets · density {((c.meta?.density ?? 0) * 100).toFixed(0)}%
                  </span>
                </div>
                <div className="flex items-center gap-2 text-[10px] text-muted">
                  <span>conf {(c.confidence * 100).toFixed(0)}%</span>
                  <span>{relTime(c.updatedAt)}</span>
                  <span>{isOpen ? "v" : ">"}</span>
                </div>
              </button>
              {isOpen && (
                <div className="border-t border-border/40 px-3 py-2">
                  <div className="grid grid-cols-2 gap-2 text-[11px] text-muted md:grid-cols-4">
                    <div>
                      <div className="uppercase tracking-wider">Members</div>
                      <div className="font-medium text-fg">{c.memberCount}</div>
                    </div>
                    <div>
                      <div className="uppercase tracking-wider">Shared mints</div>
                      <div className="font-medium text-fg">{c.meta?.sharedMintsTotal ?? 0}</div>
                    </div>
                    <div>
                      <div className="uppercase tracking-wider">Bundle mints</div>
                      <div className={`font-medium ${(c.meta?.bundleMints ?? 0) > 0 ? "text-bad" : "text-fg"}`}>
                        {c.meta?.bundleMints ?? 0}
                      </div>
                    </div>
                    <div>
                      <div className="uppercase tracking-wider">Sniper mints</div>
                      <div className={`font-medium ${(c.meta?.sniperMints ?? 0) > 0 ? "text-warn" : "text-fg"}`}>
                        {c.meta?.sniperMints ?? 0}
                      </div>
                    </div>
                  </div>
                  <div className="mt-2">
                    <div className="text-[10px] uppercase tracking-wider text-muted">Wallets</div>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {c.members.slice(0, 30).map((w) => (
                        <code key={w} className="rounded border border-border/60 bg-bg/60 px-1.5 py-0.5 text-[10px]">
                          {w.slice(0, 6)}...{w.slice(-4)}
                        </code>
                      ))}
                      {c.members.length > 30 && (
                        <span className="text-[10px] text-muted">+{c.members.length - 30} more</span>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
