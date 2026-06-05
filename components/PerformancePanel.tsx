"use client";
import { useCallback, useState } from "react";
import { useVisibleInterval } from "@/lib/ui/useVisibleInterval";

type Overall = {
  trades: number;
  wins: number;
  losses: number;
  winRate: number | null;
  totalPnlSol: number;
  avgPnlSol: number | null;
  avgWinSol: number | null;
  avgLossSol: number | null;
  expectancySol: number | null;
  bestPnlSol: number | null;
  worstPnlSol: number | null;
  avgHoldSeconds: number | null;
};

type ByExitReason = { reason: string; count: number; avgPnlSol: number; totalPnlSol: number; share: number };
type ByAction = { action: string; count: number; wins: number; winRate: number | null; totalPnlSol: number; avgPnlSol: number };
type ByBucket = { bucket: string; count: number; wins: number; winRate: number | null; avgPnlSol: number };

type Payload = {
  overall: Overall;
  byExitReason: ByExitReason[];
  byAction: ByAction[];
  byGradBucket: ByBucket[];
  byRugBucket: ByBucket[];
};

function pnlClass(v: number | null | undefined): string {
  if (v == null) return "text-muted";
  if (v > 0) return "text-ok";
  if (v < 0) return "text-bad";
  return "text-muted";
}

function fmtSol(v: number | null | undefined, signed = true): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const s = v > 0 && signed ? "+" : "";
  if (Math.abs(v) >= 1) return s + v.toFixed(3);
  if (Math.abs(v) >= 0.001) return s + v.toFixed(4);
  if (v === 0) return "0";
  return s + v.toExponential(2);
}

function fmtPct(v: number | null | undefined, digits = 0): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return (v * 100).toFixed(digits) + "%";
}

function fmtSec(s: number | null | undefined): string {
  if (s == null || !Number.isFinite(s)) return "—";
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${(s / 60).toFixed(1)}m`;
  return `${(s / 3600).toFixed(1)}h`;
}

const REASON_STYLE: Record<string, string> = {
  tp: "text-ok",
  sl: "text-bad",
  timeout: "text-warn",
};

export function PerformancePanel() {
  const [data, setData] = useState<Payload | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const tick = useCallback(async () => {
    try {
      const r = await fetch("/api/performance", { cache: "no-store" });
      if (!r.ok) {
        setErr("HTTP " + r.status);
        return;
      }
      const j = (await r.json()) as Payload;
      setData(j);
      setErr(null);
    } catch (e) {
      setErr(String(e));
    }
  }, []);

  useVisibleInterval(tick, 5_000, [tick]);

  const o = data?.overall;
  const noTrades = o == null || o.trades === 0;

  return (
    <div className="card overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
        <h2 className="text-xs font-medium uppercase tracking-wide text-muted">
          Performance{" "}
          <span className="ml-1 text-[10px] font-normal text-muted">demo · learning</span>
        </h2>
        <span className="text-[10px] text-muted">refresh 5s</span>
      </div>

      {noTrades ? (
        <div className="px-3 py-6 text-center text-muted text-xs">
          {err ? `waiting… (${err})` : "no closed demo trades yet"}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 p-3 md:grid-cols-2 xl:grid-cols-4">
          {/* Overall */}
          <div>
            <h3 className="mb-1 text-[10px] uppercase tracking-wide text-muted">Overall</h3>
            <div className="space-y-1 text-xs font-mono tabular-nums">
              <Stat label="trades" value={o!.trades.toString()} />
              <Stat label="win rate" value={fmtPct(o!.winRate)} cls={pnlClass(o!.winRate != null && o!.winRate >= 0.5 ? 1 : -1)} />
              <Stat label="total PnL" value={fmtSol(o!.totalPnlSol)} cls={pnlClass(o!.totalPnlSol)} />
              <Stat label="expectancy" value={fmtSol(o!.expectancySol)} cls={pnlClass(o!.expectancySol)} />
              <Stat label="avg win" value={fmtSol(o!.avgWinSol)} cls="text-ok" />
              <Stat label="avg loss" value={fmtSol(o!.avgLossSol)} cls="text-bad" />
              <Stat label="best" value={fmtSol(o!.bestPnlSol)} cls="text-ok" />
              <Stat label="worst" value={fmtSol(o!.worstPnlSol)} cls="text-bad" />
              <Stat label="avg hold" value={fmtSec(o!.avgHoldSeconds)} />
            </div>
          </div>

          {/* By exit reason */}
          <div>
            <h3 className="mb-1 text-[10px] uppercase tracking-wide text-muted">By exit reason</h3>
            <table className="w-full text-xs font-mono tabular-nums">
              <thead className="text-[10px] text-muted">
                <tr>
                  <th className="py-1 text-left">reason</th>
                  <th className="py-1 text-right">n</th>
                  <th className="py-1 text-right">share</th>
                  <th className="py-1 text-right">avg PnL</th>
                </tr>
              </thead>
              <tbody>
                {data!.byExitReason.map((r) => (
                  <tr key={r.reason} className="border-t border-border/40">
                    <td className={`py-1 ${REASON_STYLE[r.reason] ?? "text-muted"}`}>{r.reason}</td>
                    <td className="text-right">{r.count}</td>
                    <td className="text-right text-muted">{fmtPct(r.share)}</td>
                    <td className={`text-right ${pnlClass(r.avgPnlSol)}`}>{fmtSol(r.avgPnlSol)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* By action */}
          <div>
            <h3 className="mb-1 text-[10px] uppercase tracking-wide text-muted">By BUY action</h3>
            <table className="w-full text-xs font-mono tabular-nums">
              <thead className="text-[10px] text-muted">
                <tr>
                  <th className="py-1 text-left">action</th>
                  <th className="py-1 text-right">n</th>
                  <th className="py-1 text-right">win%</th>
                  <th className="py-1 text-right">avg</th>
                </tr>
              </thead>
              <tbody>
                {data!.byAction.map((r) => (
                  <tr key={r.action} className="border-t border-border/40">
                    <td className="py-1 text-accent">{r.action}</td>
                    <td className="text-right">{r.count}</td>
                    <td className="text-right">{fmtPct(r.winRate)}</td>
                    <td className={`text-right ${pnlClass(r.avgPnlSol)}`}>{fmtSol(r.avgPnlSol)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* By grad score bucket */}
          <div>
            <h3 className="mb-1 text-[10px] uppercase tracking-wide text-muted">By grad score</h3>
            <table className="w-full text-xs font-mono tabular-nums">
              <thead className="text-[10px] text-muted">
                <tr>
                  <th className="py-1 text-left">range</th>
                  <th className="py-1 text-right">n</th>
                  <th className="py-1 text-right">win%</th>
                  <th className="py-1 text-right">avg</th>
                </tr>
              </thead>
              <tbody>
                {data!.byGradBucket.map((r) => (
                  <tr key={r.bucket} className="border-t border-border/40">
                    <td className="py-1 text-muted">{r.bucket}</td>
                    <td className="text-right">{r.count}</td>
                    <td className="text-right">{r.count > 0 ? fmtPct(r.winRate) : "—"}</td>
                    <td className={`text-right ${pnlClass(r.avgPnlSol)}`}>
                      {r.count > 0 ? fmtSol(r.avgPnlSol) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, cls }: { label: string; value: string; cls?: string }) {
  return (
    <div className="flex items-baseline justify-between">
      <span className="text-muted">{label}</span>
      <span className={cls ?? ""}>{value}</span>
    </div>
  );
}
