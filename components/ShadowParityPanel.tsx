"use client";
import { useCallback, useState } from "react";
import { useVisibleInterval } from "@/lib/ui/useVisibleInterval";

type Pair = {
  liveId: string;
  paperId: string;
  mint: string;
  sizeSol: number;
  route: string;
  dryRun: boolean;
  liveStatus: string;
  paperStatus: string;
  livePnl: number | null;
  paperPnl: number | null;
  slippageSol: number | null;
  bothClosed: boolean;
  liveOpened: string;
  liveClosed: string | null;
};

type Resp = {
  windowHours: number;
  pairs: Pair[];
  summary: {
    total: number;
    bothClosed: number;
    avgSlippageSol: number;
    worstSlippageSol: number;
    bestSlippageSol: number;
    paperPnlTotal: number;
    livePnlTotal: number;
  };
  byRoute: { route: string; n: number; avgSlippageSol: number }[];
};

function fmtSol(v: number | null | undefined, signed = true, d = 4): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const s = v > 0 && signed ? "+" : "";
  return `${s}${v.toFixed(d)} SOL`;
}

export function ShadowParityPanel({ hours = 24 }: { hours?: number }) {
  const [data, setData] = useState<Resp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/analytics/shadow-parity?hours=${hours}`, { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as Resp;
      setData(j);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [hours]);

  useVisibleInterval(() => void load(), 30_000, [load]);

  if (!data && !err) return null;
  if (err) return null; // hide quietly when no live trades exist

  const summary = data?.summary;

  return (
    <div className="card p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-sm font-semibold">Live vs paper parity</div>
          <p className="text-[11px] text-muted">
            Each live entry opens a paper shadow trade in parallel. Slippage = paper PnL − live PnL.
            Positive slippage means live execution is leaving money on the table (fees, sandwich,
            unfavourable fills).
          </p>
        </div>
        {summary && summary.total === 0 && (
          <span className="text-[10px] text-muted">no live shadow trades yet</span>
        )}
      </div>
      {summary && summary.total > 0 && (
        <>
          <div className="mb-3 grid grid-cols-2 gap-2 md:grid-cols-5">
            <Stat label="Pairs" value={String(summary.total)} />
            <Stat label="Both closed" value={String(summary.bothClosed)} />
            <Stat
              label="Avg slippage"
              value={fmtSol(summary.avgSlippageSol)}
              tone={summary.avgSlippageSol > 0 ? "bad" : "ok"}
            />
            <Stat label="Paper PnL" value={fmtSol(summary.paperPnlTotal)} tone={summary.paperPnlTotal >= 0 ? "ok" : "bad"} />
            <Stat label="Live PnL" value={fmtSol(summary.livePnlTotal)} tone={summary.livePnlTotal >= 0 ? "ok" : "bad"} />
          </div>
          {data!.byRoute.length > 0 && (
            <div className="mb-3 flex flex-wrap gap-1 text-[10px]">
              {data!.byRoute.map((b) => (
                <span
                  key={b.route}
                  className={`pill-side ${b.avgSlippageSol > 0 ? "border-bad/40 text-bad" : "border-ok/40 text-ok"}`}
                >
                  {b.route}: {fmtSol(b.avgSlippageSol)} avg ({b.n})
                </span>
              ))}
            </div>
          )}
          <div className="max-h-[260px] overflow-auto">
            <table className="w-full text-xs">
              <thead className="text-[10px] uppercase tracking-wider text-muted">
                <tr>
                  <th className="text-left">mint</th>
                  <th className="text-right">paper</th>
                  <th className="text-right">live</th>
                  <th className="text-right">slip</th>
                  <th>status</th>
                </tr>
              </thead>
              <tbody>
                {data!.pairs.slice(0, 20).map((p) => (
                  <tr key={p.liveId} className="border-t border-border/40">
                    <td className="py-1 font-mono text-[10px]">{p.mint.slice(0, 6)}…{p.mint.slice(-4)}{p.dryRun ? " (dry)" : ""}</td>
                    <td className={`text-right ${(p.paperPnl ?? 0) >= 0 ? "text-ok" : "text-bad"}`}>{fmtSol(p.paperPnl)}</td>
                    <td className={`text-right ${(p.livePnl ?? 0) >= 0 ? "text-ok" : "text-bad"}`}>{fmtSol(p.livePnl)}</td>
                    <td className={`text-right ${(p.slippageSol ?? 0) > 0 ? "text-bad" : "text-ok"}`}>{fmtSol(p.slippageSol)}</td>
                    <td className="text-center text-[10px] text-muted">
                      {p.liveStatus === "closed" && p.paperStatus === "closed"
                        ? "closed"
                        : `${p.liveStatus[0]!}/${p.paperStatus[0]!}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "ok" | "warn" | "bad" }) {
  const cls = tone === "ok" ? "text-ok" : tone === "warn" ? "text-warn" : tone === "bad" ? "text-bad" : "text-fg";
  return (
    <div className="rounded-md border border-border bg-bg/40 p-2">
      <div className="text-[10px] uppercase tracking-wider text-muted">{label}</div>
      <div className={`mt-0.5 text-sm font-semibold ${cls}`}>{value}</div>
    </div>
  );
}
