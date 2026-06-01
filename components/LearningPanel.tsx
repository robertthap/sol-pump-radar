"use client";
import { useCallback, useState } from "react";
import { useVisibleInterval } from "@/lib/ui/useVisibleInterval";

type ActionPerf = {
  action: string;
  n: number;
  wins: number;
  losses: number;
  winRate: number | null;
  avgPnlPct: number | null;
  avgPnlSol: number | null;
  totalPnlSol: number;
};
type ModuleBucketPerf = {
  module: string;
  bucket: string;
  bucketMin: number;
  bucketMax: number;
  n: number;
  wins: number;
  winRate: number | null;
  avgPnlPct: number | null;
};
type ExitReasonPerf = { reason: string; n: number; totalPnlSol: number; avgPnlSol: number | null };
type TunerChangeRow = {
  id: string;
  ts: string;
  reason: string;
  diff: Record<string, number>;
  reverted: string;
  status: "applied" | "proposed" | "reverted";
};
type Summary = {
  windowHours: number;
  actionPerf: ActionPerf[];
  moduleBuckets: ModuleBucketPerf[];
  exitReasons: ExitReasonPerf[];
  overrides: Record<string, number>;
  changes: TunerChangeRow[];
  autoTune: "on" | "off";
  preset: string;
};

function pnlClass(v: number | null | undefined): string {
  if (v == null) return "text-muted";
  if (v > 0) return "text-ok";
  if (v < 0) return "text-bad";
  return "text-muted";
}

function fmtPct(v: number | null | undefined, digits = 0): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return (v * 100).toFixed(digits) + "%";
}

function fmtSol(v: number | null | undefined, sign = true, d = 3): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const s = v > 0 && sign ? "+" : "";
  return s + v.toFixed(d);
}

const ACTION_LABEL: Record<string, { label: string; cls: string }> = {
  BUY_STRONG: { label: "BUY+", cls: "border-ok/50 bg-ok/10 text-ok" },
  BUY_MODERATE: { label: "BUY", cls: "border-ok/40 bg-ok/5 text-ok" },
  WATCH: { label: "WATCH", cls: "border-accent/40 bg-accent/5 text-accent" },
  AVOID: { label: "AVOID", cls: "border-bad/40 bg-bad/5 text-bad" },
};

export function LearningPanel() {
  const [s, setS] = useState<Summary | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const tick = useCallback(async () => {
    try {
      const r = await fetch(`/api/learning/summary?hours=24`, { cache: "no-store" });
      if (!r.ok) {
        setErr("HTTP " + r.status);
        return;
      }
      const j = (await r.json()) as Summary;
      setS(j);
      setErr(null);
    } catch (e) {
      setErr(String(e));
    }
  }, []);

  useVisibleInterval(() => void tick(), 4_000, [tick]);

  const overrideKeys = s ? Object.keys(s.overrides) : [];

  return (
    <div className="card overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
        <h2 className="text-xs font-medium uppercase tracking-wide text-muted">
          Learning <span className="ml-1 text-[10px] font-normal text-muted">last 24h</span>
        </h2>
        <div className="flex items-center gap-2 text-[10px]">
          <span className={`pill ${s?.autoTune === "on" ? "text-ok" : "text-muted"}`}>
            auto-tune: {s?.autoTune ?? "—"}
          </span>
          <span className="pill text-muted">preset: {s?.preset ?? "—"}</span>
          {overrideKeys.length > 0 && (
            <span className="pill text-warn">
              overrides: {overrideKeys.length}
            </span>
          )}
          {err && <span className="text-bad">{err}</span>}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 p-3 lg:grid-cols-3">
        <div>
          <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted">
            Action class
          </h3>
          <table className="table-feed">
            <thead>
              <tr>
                <th>Action</th>
                <th className="text-right">N</th>
                <th className="text-right">Win</th>
                <th className="text-right">Avg %</th>
                <th className="text-right">Total SOL</th>
              </tr>
            </thead>
            <tbody>
              {(!s || s.actionPerf.length === 0) && (
                <tr>
                  <td colSpan={5} className="px-3 py-6 text-center text-muted">
                    no closed trades yet
                  </td>
                </tr>
              )}
              {s?.actionPerf.map((a) => {
                const style = ACTION_LABEL[a.action] ?? {
                  label: a.action,
                  cls: "border-border text-muted",
                };
                return (
                  <tr key={a.action} className="row-hover">
                    <td>
                      <span className={`pill-side ${style.cls}`}>{style.label}</span>
                    </td>
                    <td className="text-right font-mono tabular-nums">{a.n}</td>
                    <td className="text-right font-mono tabular-nums">{fmtPct(a.winRate)}</td>
                    <td className={`text-right font-mono tabular-nums ${pnlClass(a.avgPnlPct)}`}>
                      {fmtPct(a.avgPnlPct, 1)}
                    </td>
                    <td className={`text-right font-mono tabular-nums ${pnlClass(a.totalPnlSol)}`}>
                      {fmtSol(a.totalPnlSol)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div>
          <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted">
            Module score buckets
          </h3>
          <table className="table-feed">
            <thead>
              <tr>
                <th>Module</th>
                <th>Bucket</th>
                <th className="text-right">N</th>
                <th className="text-right">Win</th>
                <th className="text-right">Avg %</th>
              </tr>
            </thead>
            <tbody>
              {(!s || s.moduleBuckets.length === 0) && (
                <tr>
                  <td colSpan={5} className="px-3 py-6 text-center text-muted">
                    no module data yet
                  </td>
                </tr>
              )}
              {s?.moduleBuckets.map((b) => (
                <tr key={`${b.module}-${b.bucket}`} className="row-hover">
                  <td className="text-[11px]">{b.module.replace(/_.*/, "")}</td>
                  <td className="font-mono text-muted">{b.bucket}</td>
                  <td className="text-right font-mono tabular-nums">{b.n}</td>
                  <td className="text-right font-mono tabular-nums">{fmtPct(b.winRate)}</td>
                  <td className={`text-right font-mono tabular-nums ${pnlClass(b.avgPnlPct)}`}>
                    {fmtPct(b.avgPnlPct, 1)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div>
          <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted">
            Tuner activity
          </h3>
          <table className="table-feed">
            <thead>
              <tr>
                <th>When</th>
                <th>Status</th>
                <th>Diff</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {(!s || s.changes.length === 0) && (
                <tr>
                  <td colSpan={4} className="px-3 py-6 text-center text-muted">
                    no proposals yet
                  </td>
                </tr>
              )}
              {s?.changes.map((c) => {
                const diffStr = Object.keys(c.diff).length
                  ? Object.entries(c.diff)
                      .map(([k, v]) => `${k}=${(v as number).toFixed(2)}`)
                      .join(" ")
                  : "—";
                const statusCls =
                  c.status === "applied"
                    ? "text-ok"
                    : c.status === "reverted"
                      ? "text-bad"
                      : "text-warn";
                return (
                  <tr key={c.id} className="row-hover">
                    <td className="font-mono text-[10px] text-muted">
                      {new Date(c.ts).toLocaleTimeString()}
                    </td>
                    <td>
                      <span className={`pill-side ${statusCls}`}>{c.status}</span>
                    </td>
                    <td className="font-mono text-[10px]" title={diffStr}>
                      {diffStr}
                    </td>
                    <td className="truncate text-[11px] text-muted" title={c.reason}>
                      {c.reason}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {s && s.exitReasons.length > 0 && (
        <div className="border-t border-border bg-bg/40 px-3 py-2 text-[11px]">
          <span className="text-muted">exits last 24h: </span>
          {s.exitReasons.map((e, i) => (
            <span key={e.reason} className="font-mono">
              {i > 0 && <span className="mx-1.5 text-muted">·</span>}
              <span
                className={
                  e.reason === "tp"
                    ? "text-ok"
                    : e.reason === "sl"
                      ? "text-bad"
                      : "text-muted"
                }
              >
                {e.reason}
              </span>{" "}
              <span className="text-muted">
                ({e.n}, {fmtSol(e.totalPnlSol)})
              </span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
