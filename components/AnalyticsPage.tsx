"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useVisibleInterval } from "@/lib/ui/useVisibleInterval";

type EquityPoint = {
  ts: string;
  paperEquity: number;
  liveEquity: number;
  paperRealized: number;
  liveRealized: number;
};
type DailyPnl = {
  date: string;
  paperPnl: number;
  livePnl: number;
  paperTrades: number;
  liveTrades: number;
};
type TradeRow = {
  id: string;
  source: "paper" | "live";
  mint: string;
  symbol: string | null;
  status: string;
  sizeSol: number;
  entryPrice: number | null;
  exitPrice: number | null;
  pnlSol: number | null;
  pnlPct: number | null;
  exitReason: string | null;
  action: string | null;
  openedAt: string;
  closedAt: string | null;
  holdSeconds: number | null;
  modules: Record<string, number> | null;
};
type Distribution = { bucket: string; loPct: number; hiPct: number; count: number };
type MintPerf = {
  mint: string;
  symbol: string | null;
  trades: number;
  wins: number;
  totalPnlSol: number;
};
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
type Summary = {
  windowHours: number;
  source: "all" | "paper" | "live";
  mode?: "demo" | "real";
  overall: Overall;
  equity: EquityPoint[];
  daily: DailyPnl[];
  trades: TradeRow[];
  distribution: Distribution[];
  topMints: { winners: MintPerf[]; losers: MintPerf[] };
};

const RANGES: Array<{ id: string; label: string; hours: number }> = [
  { id: "1h", label: "1H", hours: 1 },
  { id: "6h", label: "6H", hours: 6 },
  { id: "24h", label: "24H", hours: 24 },
  { id: "7d", label: "7D", hours: 24 * 7 },
  { id: "30d", label: "30D", hours: 24 * 30 },
];

function fmtSol(v: number | null | undefined, signed = true, d = 3): string {
  if (v == null || !Number.isFinite(v)) return "-";
  const s = v > 0 && signed ? "+" : "";
  return s + v.toFixed(d);
}
function fmtPct(v: number | null | undefined, d = 1): string {
  if (v == null || !Number.isFinite(v)) return "-";
  return (v * 100).toFixed(d) + "%";
}
function fmtSec(s: number | null | undefined): string {
  if (s == null || !Number.isFinite(s)) return "-";
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${(s / 60).toFixed(1)}m`;
  return `${(s / 3600).toFixed(1)}h`;
}
function pnlClass(v: number | null | undefined): string {
  if (v == null) return "text-muted";
  if (v > 0) return "text-ok";
  if (v < 0) return "text-bad";
  return "text-muted";
}
function shortMint(m: string): string {
  return m.length <= 12 ? m : `${m.slice(0, 4)}...${m.slice(-4)}`;
}

type RugStats = {
  total: number;
  rugged: number;
  stalled: number;
  active: number;
  ruggedPct: number;
  avgPeakVSol: number | null;
  avgDrawdown: number | null;
};

export function AnalyticsClient() {
  const [hours, setHours] = useState(24);
  // Analytics source is enforced server-side by the current trading mode (Demo→paper, Real→live).
  const source = "all" as const;
  const [data, setData] = useState<Summary | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [rugStats, setRugStats] = useState<RugStats | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/rug-stats", { cache: "no-store" })
      .then((r) => r.json())
      .then((j: { stats: RugStats }) => {
        if (alive) setRugStats(j.stats);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const tick = useCallback(async () => {
    try {
      const r = await fetch(`/api/analytics/summary?hours=${hours}&source=${source}&limit=300`, {
        cache: "no-store",
      });
      if (!r.ok) {
        setErr(`HTTP ${r.status}`);
        return;
      }
      const j = (await r.json()) as Summary;
      setData(j);
      setErr(null);
      setLoading(false);
    } catch (e) {
      setErr(String(e));
    }
  }, [hours, source]);

  useEffect(() => {
    setLoading(true);
    void tick();
  }, [tick]);

  useVisibleInterval(tick, 5_000, [tick]);

  const equityViewBox = useMemo(() => computeEquityPath(data?.equity ?? []), [data?.equity]);
  const dailyMax = useMemo(() => {
    if (!data) return 0;
    return Math.max(
      0.001,
      ...data.daily.map((d) => Math.abs(d.paperPnl) + Math.abs(d.livePnl)),
    );
  }, [data]);
  const distMax = useMemo(() => {
    if (!data) return 1;
    return Math.max(1, ...data.distribution.map((d) => d.count));
  }, [data]);

  return (
    <main className="app-page app-page-wide">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-base font-semibold tracking-tight">Analytics</h1>
        <div className="flex flex-wrap items-center gap-1">
          <div className="flex items-center gap-0 rounded-md border border-border p-0.5">
            {RANGES.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => setHours(r.hours)}
                className={`px-2.5 py-1 text-xs ${
                  hours === r.hours
                    ? "rounded-sm bg-accent/15 text-accent"
                    : "text-muted hover:text-fg"
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>
          <span
            className="rounded-md border border-border px-2.5 py-1 text-xs font-medium uppercase text-muted"
            title="Analytics are scoped to your current wallet mode"
          >
            {data?.mode === "real" ? "Real" : "Demo"} trades
          </span>
          <a
            className="rounded-md border border-border px-2.5 py-1 text-xs text-muted hover:bg-panel/5 hover:text-fg"
            href={`/api/trades/export?source=${data?.mode === "real" ? "live" : "paper"}&status=closed`}
            download
            title="Download closed trades as CSV (tax records)"
          >
            Download CSV
          </a>
          {loading && <span className="text-[10px] text-muted">loading...</span>}
          {err && <span className="text-[10px] text-bad">{err}</span>}
        </div>
      </div>

      {rugStats && rugStats.total > 0 && (
        <section className="mb-3 rounded-md border border-warn/40 bg-warn/5 px-3 py-2 text-xs">
          <span className="mr-2 text-[10px] font-semibold uppercase tracking-wider text-warn">
            Inactivity-based rug labels (Kalacheva 2026 §4.2)
          </span>
          <span className="text-fg">
            {(rugStats.ruggedPct * 100).toFixed(1)}% of last-48h tokens are rugged
          </span>
          <span className="ml-2 text-muted">
            ({rugStats.rugged.toLocaleString()} rugged · {rugStats.stalled.toLocaleString()} stalled ·{" "}
            {rugStats.active.toLocaleString()} active · {rugStats.total.toLocaleString()} labelled)
          </span>
          {rugStats.avgPeakVSol != null && rugStats.avgDrawdown != null && (
            <span className="ml-2 text-muted">
              · avg peak pool {rugStats.avgPeakVSol.toFixed(2)} to drawdown{" "}
              {(rugStats.avgDrawdown * 100).toFixed(0)}%
            </span>
          )}
        </section>
      )}

      <section className="mb-3 grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-7">
        <Stat label="Trades" value={data ? String(data.overall.trades) : "-"} />
        <Stat
          label="Win rate"
          value={fmtPct(data?.overall.winRate ?? null, 0)}
          tone={data?.overall.winRate != null && data.overall.winRate >= 0.5 ? "ok" : "muted"}
        />
        <Stat
          label="Total PnL"
          value={fmtSol(data?.overall.totalPnlSol ?? null)}
          tone={
            data?.overall.totalPnlSol == null
              ? "muted"
              : data.overall.totalPnlSol > 0
                ? "ok"
                : data.overall.totalPnlSol < 0
                  ? "bad"
                  : "muted"
          }
        />
        <Stat
          label="Expectancy"
          value={fmtSol(data?.overall.expectancySol ?? null, true, 4)}
          tone={
            data?.overall.expectancySol == null
              ? "muted"
              : data.overall.expectancySol > 0
                ? "ok"
                : "bad"
          }
        />
        <Stat label="Avg win" value={fmtSol(data?.overall.avgWinSol ?? null, true, 4)} tone="ok" />
        <Stat label="Avg loss" value={fmtSol(data?.overall.avgLossSol ?? null, true, 4)} tone="bad" />
        <Stat label="Avg hold" value={fmtSec(data?.overall.avgHoldSeconds)} />
      </section>

      <section className="mb-3 grid grid-cols-1 gap-3 xl:grid-cols-3">
        <div className="card xl:col-span-2 overflow-hidden">
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <h2 className="text-xs font-medium uppercase tracking-wide text-muted">
              Equity curve
            </h2>
            <div className="flex items-center gap-3 text-[10px]">
              <span className="flex items-center gap-1 text-muted">
                <span className="inline-block h-2 w-3 rounded-sm bg-accent/70" /> paper
              </span>
              <span className="flex items-center gap-1 text-muted">
                <span className="inline-block h-2 w-3 rounded-sm bg-warn/70" /> live
              </span>
            </div>
          </div>
          <div className="px-3 py-2">
            {data && data.equity.length > 0 ? (
              <EquityChart data={data.equity} bbox={equityViewBox} />
            ) : (
              <div className="flex h-40 items-center justify-center text-xs text-muted">
                no closed trades yet in this window
              </div>
            )}
          </div>
        </div>

        <div className="card overflow-hidden">
          <div className="border-b border-border px-3 py-2">
            <h2 className="text-xs font-medium uppercase tracking-wide text-muted">
              PnL distribution
            </h2>
          </div>
          <div className="px-3 py-2 text-xs">
            {data && data.distribution.length > 0 ? (
              <ul className="space-y-1.5">
                {data.distribution.map((d) => (
                  <li key={d.bucket} className="flex items-center gap-2">
                    <span className="w-24 text-[10px] font-mono text-muted">{d.bucket}</span>
                    <div className="relative h-3 flex-1 rounded-sm bg-border/40">
                      <div
                        className={`absolute inset-y-0 left-0 rounded-sm ${
                          d.loPct < 0 ? "bg-bad/60" : "bg-ok/60"
                        }`}
                        style={{ width: `${(d.count / distMax) * 100}%` }}
                      />
                    </div>
                    <span className="w-8 text-right font-mono text-muted">{d.count}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="flex h-40 items-center justify-center text-muted">no data</div>
            )}
          </div>
        </div>
      </section>

      <section className="mb-3 grid grid-cols-1 gap-3 xl:grid-cols-3">
        <div className="card overflow-hidden xl:col-span-2">
          <div className="border-b border-border px-3 py-2">
            <h2 className="text-xs font-medium uppercase tracking-wide text-muted">
              Daily P&amp;L
            </h2>
          </div>
          <div className="px-3 py-3">
            {data && data.daily.length > 0 ? (
              <DailyBars daily={data.daily} max={dailyMax} />
            ) : (
              <div className="flex h-32 items-center justify-center text-xs text-muted">
                no daily data
              </div>
            )}
          </div>
        </div>

        <div className="card overflow-hidden">
          <div className="grid grid-cols-1 divide-y divide-border sm:grid-cols-2 sm:divide-x sm:divide-y-0">
            <div>
              <div className="border-b border-border px-3 py-2 text-[10px] uppercase tracking-wider text-muted">
                Top winners
              </div>
              <ul className="px-2 py-1.5 text-xs">
                {data && data.topMints.winners.length > 0 ? (
                  data.topMints.winners.map((m) => (
                    <li key={m.mint} className="flex items-center justify-between py-0.5">
                      <Link
                        href={`/token/${m.mint}`}
                        className="truncate font-mono text-accent hover:underline"
                      >
                        {m.symbol ?? shortMint(m.mint)}
                      </Link>
                      <span className="font-mono text-ok">{fmtSol(m.totalPnlSol)}</span>
                    </li>
                  ))
                ) : (
                  <li className="px-1 py-2 text-muted">none yet</li>
                )}
              </ul>
            </div>
            <div>
              <div className="border-b border-border px-3 py-2 text-[10px] uppercase tracking-wider text-muted">
                Top losers
              </div>
              <ul className="px-2 py-1.5 text-xs">
                {data && data.topMints.losers.length > 0 ? (
                  data.topMints.losers.map((m) => (
                    <li key={m.mint} className="flex items-center justify-between py-0.5">
                      <Link
                        href={`/token/${m.mint}`}
                        className="truncate font-mono text-accent hover:underline"
                      >
                        {m.symbol ?? shortMint(m.mint)}
                      </Link>
                      <span className="font-mono text-bad">{fmtSol(m.totalPnlSol)}</span>
                    </li>
                  ))
                ) : (
                  <li className="px-1 py-2 text-muted">none yet</li>
                )}
              </ul>
            </div>
          </div>
        </div>
      </section>

      <section className="card overflow-hidden">
        <div className="border-b border-border px-3 py-2">
          <h2 className="text-xs font-medium uppercase tracking-wide text-muted">
            Trade history{" "}
            <span className="ml-1 text-[10px] font-normal text-muted">
              ({data?.trades.length ?? 0} rows)
            </span>
          </h2>
        </div>
        <div className="table-scroll table-scroll-wide max-h-[600px] overflow-y-auto">
          <table className="table-feed">
            <thead>
              <tr>
                <th>Source</th>
                <th>Token</th>
                <th>Action</th>
                <th>Status</th>
                <th className="text-right">Size</th>
                <th className="text-right">Entry</th>
                <th className="text-right">Exit</th>
                <th className="text-right">PnL SOL</th>
                <th className="text-right">PnL %</th>
                <th>Reason</th>
                <th className="text-right">Hold</th>
                <th>Opened</th>
              </tr>
            </thead>
            <tbody>
              {!data || data.trades.length === 0 ? (
                <tr>
                  <td colSpan={12} className="px-3 py-8 text-center text-muted">
                    no trades in window
                  </td>
                </tr>
              ) : (
                data.trades.map((t) => (
                  <tr key={`${t.source}:${t.id}`} className="row-hover">
                    <td>
                      <span
                        className={`pill-side ${
                          t.source === "live" ? "border-bad/40 text-bad" : "border-muted/40 text-muted"
                        }`}
                      >
                        {t.source.toUpperCase()}
                      </span>
                    </td>
                    <td>
                      <Link
                        href={`/token/${t.mint}`}
                        className="font-mono text-accent hover:underline"
                      >
                        {t.symbol ?? shortMint(t.mint)}
                      </Link>
                    </td>
                    <td className="font-mono text-[10px] text-muted">{t.action ?? "-"}</td>
                    <td>
                      <span
                        className={`pill-side ${
                          t.status === "open"
                            ? "border-accent/30 text-accent"
                            : t.status === "closed"
                              ? "border-muted/40 text-muted"
                              : "border-bad/40 text-bad"
                        }`}
                      >
                        {t.status}
                      </span>
                    </td>
                    <td className="text-right font-mono">{fmtSol(t.sizeSol, false, 3)}</td>
                    <td className="text-right font-mono text-muted">
                      {fmtSol(t.entryPrice, false, 2)}
                    </td>
                    <td className="text-right font-mono text-muted">
                      {fmtSol(t.exitPrice, false, 2)}
                    </td>
                    <td className={`text-right font-mono ${pnlClass(t.pnlSol)}`}>
                      {fmtSol(t.pnlSol, true, 4)}
                    </td>
                    <td className={`text-right font-mono ${pnlClass(t.pnlPct)}`}>
                      {fmtPct(t.pnlPct, 1)}
                    </td>
                    <td className="text-[10px] text-muted">{t.exitReason ?? "-"}</td>
                    <td className="text-right font-mono text-muted">{fmtSec(t.holdSeconds)}</td>
                    <td className="font-mono text-[10px] text-muted">
                      {new Date(t.openedAt).toLocaleTimeString()}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "ok" | "bad" | "muted";
}) {
  const cls =
    tone === "ok" ? "text-ok" : tone === "bad" ? "text-bad" : tone === "muted" ? "text-muted" : "";
  return (
    <div className="card flex flex-col gap-0.5 px-3 py-2">
      <span className="text-[10px] uppercase tracking-wider text-muted">{label}</span>
      <span className={`font-mono text-sm ${cls}`}>{value}</span>
    </div>
  );
}

type EquityBBox = { minY: number; maxY: number; w: number; h: number };
function computeEquityPath(eq: EquityPoint[]): EquityBBox {
  if (!eq.length) return { minY: 0, maxY: 1, w: 800, h: 220 };
  const ys: number[] = [];
  for (const p of eq) {
    ys.push(p.paperEquity);
    ys.push(p.liveEquity);
  }
  let minY = Math.min(...ys);
  let maxY = Math.max(...ys);
  if (minY === maxY) {
    minY -= 0.01;
    maxY += 0.01;
  }
  return { minY, maxY, w: 800, h: 220 };
}

function EquityChart({ data, bbox }: { data: EquityPoint[]; bbox: EquityBBox }) {
  const { w, h, minY, maxY } = bbox;
  const padX = 24;
  const padY = 12;
  const span = maxY - minY;
  const xFor = (i: number) => padX + (i / Math.max(1, data.length - 1)) * (w - padX * 2);
  const yFor = (v: number) => padY + (1 - (v - minY) / span) * (h - padY * 2);
  const pathFor = (key: "paperEquity" | "liveEquity") =>
    data
      .map((p, i) => {
        const x = xFor(i);
        const y = yFor(p[key]);
        return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");

  // Zero/start lines
  const start = data[0]?.paperEquity ?? minY;
  const startY = yFor(start);

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full" preserveAspectRatio="none">
      <line
        x1={padX}
        y1={startY}
        x2={w - padX}
        y2={startY}
        stroke="rgb(120 130 145 / 0.25)"
        strokeDasharray="3 4"
      />
      <path
        d={pathFor("paperEquity")}
        fill="none"
        stroke="rgb(120 200 255)"
        strokeWidth={1.5}
        opacity={0.9}
      />
      <path
        d={pathFor("liveEquity")}
        fill="none"
        stroke="rgb(245 200 100)"
        strokeWidth={1.5}
        opacity={0.85}
      />
      <text x={padX} y={padY + 8} fill="rgb(120 130 145)" fontSize="10" fontFamily="monospace">
        {maxY.toFixed(3)}
      </text>
      <text
        x={padX}
        y={h - padY + 4}
        fill="rgb(120 130 145)"
        fontSize="10"
        fontFamily="monospace"
      >
        {minY.toFixed(3)}
      </text>
    </svg>
  );
}

function DailyBars({ daily, max }: { daily: DailyPnl[]; max: number }) {
  return (
    <div className="flex items-end gap-1.5">
      {daily.map((d) => {
        const total = d.paperPnl + d.livePnl;
        const h = Math.min(64, Math.abs(total) / max * 64);
        const isPos = total >= 0;
        return (
          <div
            key={d.date}
            className="flex flex-1 flex-col items-center gap-1"
            title={`${d.date}\npaper ${d.paperPnl.toFixed(4)} (${d.paperTrades})\nlive ${d.livePnl.toFixed(4)} (${d.liveTrades})`}
          >
            <div className="flex h-16 items-end">
              <div
                className={`w-full rounded-sm ${isPos ? "bg-ok/70" : "bg-bad/70"}`}
                style={{ height: `${h}px`, minHeight: total === 0 ? "1px" : "2px" }}
              />
            </div>
            <span className="text-[9px] font-mono text-muted">{d.date.slice(5)}</span>
          </div>
        );
      })}
    </div>
  );
}
