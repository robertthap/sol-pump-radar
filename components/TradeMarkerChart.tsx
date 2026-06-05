"use client";

import { useEffect, useRef, useState } from "react";
import { mcapUsdFromVSol } from "@/lib/dex/curve-mcap";

export type ChartMarker = {
  id: string;
  side: "buy" | "sell";
  ts: string;
  vSol: number | null;
  mcapUsd?: number | null;
  sizeSol?: number | null;
};

type Point = { t: number; mcap: number };

function fmtMcap(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}K`;
  return `$${Math.round(v)}`;
}
function fmtTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
function fmtPct(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const p = v * 100;
  return `${p >= 0 ? "+" : ""}${p.toFixed(1)}%`;
}

/** Default trader avatar ringed blue (buy) / red (sell), pinned at a trade point. */
function AvatarMarker({ x, y, side }: { x: number; y: number; side: "buy" | "sell" }) {
  const ring = side === "buy" ? "#3b82f6" : "#ef4444";
  const r = 11;
  return (
    <g transform={`translate(${x},${y})`}>
      <circle cx={0} cy={0} r={r + 3} fill={ring} opacity={0.16} />
      <circle cx={0} cy={0} r={r} fill="#0f172a" stroke={ring} strokeWidth={2.5} />
      <circle cx={0} cy={-2.8} r={3.4} fill="#cbd5e1" />
      <path d="M -5.2 6.2 a 5.2 5 0 0 1 10.4 0 Z" fill="#cbd5e1" />
    </g>
  );
}

/**
 * pump.fun-style trade chart: our own price line (curve mcap from vSol) with the
 * system's buy (blue ring) / sell (red ring) markers pinned at the exact points.
 * Hover for a crosshair + mcap-at-time; live mcap shown on the side; click the
 * address to copy. DexScreener's iframe can't be drawn on, hence our own chart.
 */
export function TradeMarkerChart({
  mint,
  markers,
  currentMcapUsd,
  entryMcapUsd,
  pnlPct,
  status,
  height = 260,
}: {
  mint: string;
  markers: ChartMarker[];
  currentMcapUsd?: number | null;
  entryMcapUsd?: number | null;
  pnlPct?: number | null;
  status?: "open" | "closed";
  height?: number;
}) {
  const [points, setPoints] = useState<Point[] | null>(null);
  const [err, setErr] = useState(false);
  const [hover, setHover] = useState<{ x: number; y: number; idx: number } | null>(null);
  const [copied, setCopied] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(560);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w && w > 0) setWidth(Math.floor(w));
    });
    ro.observe(el);
    setWidth(Math.floor(el.getBoundingClientRect().width) || 560);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch(`/api/tokens/${encodeURIComponent(mint)}/price-series?limit=800`, {
          cache: "no-store",
        });
        if (!r.ok) throw new Error(String(r.status));
        const j = (await r.json()) as { points: { t: string; vSol: number }[] };
        const pts: Point[] = (j.points ?? [])
          .map((p) => ({ t: Date.parse(p.t), mcap: mcapUsdFromVSol(p.vSol) ?? 0 }))
          .filter((p) => Number.isFinite(p.t) && p.mcap > 0);
        if (alive) {
          setPoints(pts);
          setErr(false);
        }
      } catch {
        if (alive) setErr(true);
      }
    };
    void load();
    const id = window.setInterval(load, 8000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [mint]);

  const copyAddr = async () => {
    try {
      await navigator.clipboard.writeText(mint);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard blocked */
    }
  };

  const padL = 18;
  const padR = 18;
  const padT = 18;
  const padB = 20;
  const W = Math.max(240, width);
  const H = height;

  const markerData = markers
    .filter((m) => m.vSol != null && m.vSol > 0)
    .map((m) => ({ ...m, t: Date.parse(m.ts), mcap: mcapUsdFromVSol(m.vSol!) ?? 0 }))
    .filter((m) => Number.isFinite(m.t) && m.mcap > 0);

  // Append the REALTIME mcap as the latest point so the line tracks the live value.
  // The polled price-series is event-based and lags; the parent refreshes
  // `currentMcapUsd` (real pump/DEX mcap) every few seconds.
  const livePoint =
    currentMcapUsd != null && Number.isFinite(currentMcapUsd) && currentMcapUsd > 0 && status !== "closed"
      ? { t: Date.now(), mcap: currentMcapUsd }
      : null;
  const pts = points ? (livePoint ? [...points, livePoint] : points) : [];
  const allT = [...pts.map((p) => p.t), ...markerData.map((m) => m.t)];
  const allM = [...pts.map((p) => p.mcap), ...markerData.map((m) => m.mcap)];

  const loading = points == null;
  const empty = !loading && pts.length < 2 && markerData.length === 0;

  // Live mcap for the side panel: prefer the real (pump) current mcap; else the
  // latest point on our line.
  const liveMcap =
    currentMcapUsd != null && currentMcapUsd > 0
      ? currentMcapUsd
      : pts.length
        ? pts[pts.length - 1]!.mcap
        : null;

  let chart: React.ReactNode;
  if (loading) {
    chart = <div className="flex h-full items-center justify-center text-xs text-muted">Loading chart…</div>;
  } else if (empty) {
    chart = (
      <div className="flex h-full items-center justify-center px-3 text-center text-xs text-muted">
        {err ? "Price feed unavailable" : "Waiting for on-chain price data for this coin…"}
      </div>
    );
  } else {
    const tMin = Math.min(...allT);
    const tMax = Math.max(...allT);
    const mMin = Math.min(...allM);
    const mMax = Math.max(...allM);
    const tSpan = tMax - tMin || 1;
    const mSpan = mMax - mMin || mMax || 1;
    const mPad = mSpan * 0.12;
    const yLo = Math.max(0, mMin - mPad);
    const yHi = mMax + mPad;
    const ySpan = yHi - yLo || 1;

    const xOf = (t: number) => padL + ((t - tMin) / tSpan) * (W - padL - padR);
    const yOf = (m: number) => padT + (1 - (m - yLo) / ySpan) * (H - padT - padB);

    const linePts = pts.map((p) => `${xOf(p.t).toFixed(1)},${yOf(p.mcap).toFixed(1)}`);
    const areaPath =
      pts.length >= 2
        ? `M ${xOf(pts[0]!.t).toFixed(1)},${(H - padB).toFixed(1)} L ${linePts.join(" L ")} L ${xOf(
            pts[pts.length - 1]!.t,
          ).toFixed(1)},${(H - padB).toFixed(1)} Z`
        : "";

    const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
      if (pts.length === 0) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      // nearest point by x
      let best = 0;
      let bestD = Infinity;
      for (let i = 0; i < pts.length; i++) {
        const d = Math.abs(xOf(pts[i]!.t) - mx);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      setHover({ x: xOf(pts[best]!.t), y: yOf(pts[best]!.mcap), idx: best });
    };

    const hp = hover && pts[hover.idx] ? pts[hover.idx]! : null;

    chart = (
      <svg
        width={W}
        height={H}
        className="block cursor-crosshair"
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id="tmc-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#22c55e" stopOpacity={0.22} />
            <stop offset="100%" stopColor="#22c55e" stopOpacity={0} />
          </linearGradient>
        </defs>
        {areaPath && <path d={areaPath} fill="url(#tmc-fill)" />}
        {pts.length >= 2 && (
          <polyline points={linePts.join(" ")} fill="none" stroke="#22c55e" strokeWidth={1.5} strokeLinejoin="round" />
        )}
        {/* crosshair */}
        {hp && hover && (
          <g pointerEvents="none">
            <line x1={hover.x} y1={padT} x2={hover.x} y2={H - padB} stroke="#94a3b8" strokeWidth={0.75} strokeDasharray="2 2" />
            <circle cx={hover.x} cy={hover.y} r={3} fill="#22c55e" stroke="#fff" strokeWidth={1} />
          </g>
        )}
        {/* trade markers */}
        {markerData.map((m) => {
          const x = xOf(m.t);
          const y = yOf(m.mcap);
          return (
            <g key={m.id} pointerEvents="none">
              <line x1={x} y1={padT} x2={x} y2={H - padB} stroke={m.side === "buy" ? "#3b82f6" : "#ef4444"} strokeWidth={0.75} strokeDasharray="3 3" opacity={0.5} />
              <AvatarMarker x={x} y={y} side={m.side} />
              <title>
                {m.side === "buy" ? "BUY" : "SELL"} · {fmtMcap(m.mcapUsd ?? m.mcap)} · {fmtTime(m.t)}
                {m.sizeSol != null ? ` · ${m.sizeSol.toFixed(3)} SOL` : ""}
              </title>
            </g>
          );
        })}
      </svg>
    );

    // crosshair tooltip is rendered outside the svg (HTML overlay) below
  }

  const hp = !loading && !empty && hover && pts[hover.idx] ? pts[hover.idx]! : null;

  return (
    <div className="rounded-md border border-border/60 bg-bg/40">
      <div className="flex flex-wrap items-center justify-between gap-2 px-2 py-1 text-[10px] text-muted">
        <span className="flex items-center gap-3">
          {liveMcap != null && (
            <span className="flex items-center gap-1.5" title="Realtime market cap of this coin">
              <span className="text-[9px] uppercase tracking-wide text-muted">
                {status === "closed" ? "Exit mcap" : "Live mcap"}
              </span>
              <span className="font-mono text-xs font-semibold text-fg">{fmtMcap(liveMcap)}</span>
              {status !== "closed" && (
                <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-ok" aria-hidden />
              )}
            </span>
          )}
          <span className="flex items-center gap-1">
            <span className="inline-block h-2.5 w-2.5 rounded-full border-2" style={{ borderColor: "#3b82f6" }} />
            Buy
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-2.5 w-2.5 rounded-full border-2" style={{ borderColor: "#ef4444" }} />
            Sell
          </span>
        </span>
        <button
          type="button"
          onClick={copyAddr}
          title="Click to copy coin address"
          className="rounded border border-border/60 px-1.5 py-0.5 font-mono text-[10px] hover:bg-bg/60"
        >
          {copied ? "✓ copied" : `${mint.slice(0, 4)}…${mint.slice(-4)} ⧉`}
        </button>
        <a
          href={`https://dexscreener.com/solana/${encodeURIComponent(mint)}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-accent hover:underline"
        >
          DexScreener ↗
        </a>
      </div>

      <div className="flex flex-col sm:flex-row">
        {/* chart + crosshair tooltip overlay */}
        <div ref={wrapRef} style={{ height: `${height}px` }} className="relative min-h-0 w-full flex-1 overflow-hidden">
          {chart}
          {hp && hover && (
            <div
              className="pointer-events-none absolute z-10 rounded border border-border/70 bg-panel/95 px-1.5 py-1 text-[10px] shadow"
              style={{
                left: Math.min(Math.max(hover.x + 8, 4), W - 96),
                top: 4,
              }}
            >
              <div className="font-mono font-semibold text-fg">{fmtMcap(hp.mcap)}</div>
              <div className="text-muted">{fmtTime(hp.t)}</div>
            </div>
          )}
        </div>

        {/* live market-cap side panel */}
        <div className="flex w-full shrink-0 flex-row items-center justify-around gap-4 border-t border-border/50 px-3 py-2 text-center sm:w-[92px] sm:flex-col sm:justify-center sm:gap-2 sm:border-l sm:border-t-0 sm:px-2">
          <div>
            <p className="text-[9px] uppercase tracking-wide text-muted">
              {status === "closed" ? "Exit mcap" : "Live mcap"}
            </p>
            <p className="font-mono text-sm font-semibold text-fg">{fmtMcap(liveMcap)}</p>
            {status !== "closed" && liveMcap != null && (
              <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-ok" aria-hidden />
            )}
          </div>
          <div>
            <p className="text-[9px] uppercase tracking-wide text-muted">Entry</p>
            <p className="font-mono text-xs">{fmtMcap(entryMcapUsd)}</p>
          </div>
          {pnlPct != null && (
            <div>
              <p className="text-[9px] uppercase tracking-wide text-muted">PnL</p>
              <p className={`font-mono text-xs ${pnlPct >= 0 ? "text-ok" : "text-bad"}`}>{fmtPct(pnlPct)}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
