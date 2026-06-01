"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useVisibleInterval } from "@/lib/ui/useVisibleInterval";

type Candle = {
  t: string;
  open: number;
  high: number;
  low: number;
  close: number;
  buys: number;
  sells: number;
};

type SignalMarker = {
  id: string;
  ts: string;
  action: string;
  confluenceScore: number;
  vSol: number | null;
  reason: string;
};

export type TradeMarker = {
  id: string;
  ts: string;
  side: "buy" | "sell";
  vSol: number | null;
  sizeSol?: number | null;
  mcapUsd?: number | null;
};

function fmtMcap(v: number | null | undefined) {
  if (v == null || !Number.isFinite(v)) return null;
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}K`;
  return `$${Math.round(v)}`;
}

function markerColor(action: string) {
  if (action === "BUY_STRONG") return "#22c55e";
  if (action === "BUY_MODERATE") return "#4ade80";
  if (action === "WATCH") return "#60a5fa";
  if (action === "AVOID") return "#ef4444";
  return "#94a3b8";
}

function markerLabel(action: string) {
  if (action === "BUY_STRONG") return "B+";
  if (action === "BUY_MODERATE") return "B";
  if (action === "WATCH") return "W";
  if (action === "AVOID") return "X";
  return "?";
}

function bucketTs(iso: string): string {
  const d = new Date(iso);
  d.setUTCSeconds(0, 0);
  return d.toISOString().slice(0, 19) + "Z";
}

export function TokenChart({
  mint,
  hours = 24,
  tall,
  compact,
  candles: externalCandles,
  signalMarkers: externalSignals,
  tradeMarkers: externalTrades,
  entryLine,
  hideSignalLegend,
  showTradeCrosshair = false,
}: {
  mint: string;
  hours?: number;
  tall?: boolean;
  compact?: boolean;
  candles?: Candle[];
  signalMarkers?: SignalMarker[];
  tradeMarkers?: TradeMarker[];
  /** Horizontal entry price line (pool SOL at buy). */
  entryLine?: number | null;
  hideSignalLegend?: boolean;
  /** GMGN-style crosshair + pin on trade markers. */
  showTradeCrosshair?: boolean;
}) {
  const [candles, setCandles] = useState<Candle[]>(externalCandles ?? []);
  const [signals, setSignals] = useState<SignalMarker[]>(externalSignals ?? []);
  const [trades, setTrades] = useState<TradeMarker[]>(externalTrades ?? []);
  const [loading, setLoading] = useState(!externalCandles?.length);

  useEffect(() => {
    if (externalCandles && externalCandles.length > 0) {
      setCandles(externalCandles);
      setSignals(externalSignals ?? []);
      setTrades(externalTrades ?? []);
      setLoading(false);
    }
  }, [externalCandles, externalSignals, externalTrades]);

  const load = useCallback(async () => {
    if (externalCandles) return;
    try {
      const r = await fetch(`/api/tokens/${mint}/chart?hours=${hours}`, { cache: "no-store" });
      if (!r.ok) return;
      const j = (await r.json()) as { candles: Candle[]; signals?: SignalMarker[] };
      setCandles(j.candles ?? []);
      setSignals(j.signals ?? []);
      setLoading(false);
    } catch {
      setLoading(false);
    }
  }, [mint, hours, externalCandles]);

  useVisibleInterval(() => void load(), externalCandles ? 0 : 4_000, [load, externalCandles]);

  const candleIndexByT = useMemo(() => {
    const m = new Map<string, number>();
    candles.forEach((c, i) => m.set(c.t.slice(0, 19), i));
    return m;
  }, [candles]);

  function placeOnCandles<T extends { ts: string }>(items: T[]) {
    return items
      .map((s) => {
        const key = bucketTs(s.ts);
        let idx = candleIndexByT.get(key);
        if (idx == null) {
          const ts = new Date(s.ts).getTime();
          let best = -1;
          let bestDiff = Infinity;
          candles.forEach((c, i) => {
            const diff = Math.abs(new Date(c.t).getTime() - ts);
            if (diff < bestDiff) {
              bestDiff = diff;
              best = i;
            }
          });
          idx = best >= 0 ? best : undefined;
        }
        if (idx == null || idx < 0) return null;
        return { ...s, idx };
      })
      .filter((x): x is T & { idx: number } => x != null);
  }

  const placedMarkers = useMemo(
    () => placeOnCandles(signals),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- placeOnCandles closes over candles
    [signals, candles, candleIndexByT],
  );

  const placedTrades = useMemo(
    () => placeOnCandles(trades),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [trades, candles, candleIndexByT],
  );

  const chartHeightClass = tall ? "h-[400px]" : compact ? "h-36" : "h-60";
  const chartInnerH = tall ? 400 : compact ? 144 : 240;

  if (loading) {
    return (
      <div
        className={`flex items-center justify-center text-xs text-muted ${chartHeightClass}`}
      >
        Loading chart…
      </div>
    );
  }
  if (candles.length < 2) {
    return (
      <div
        className={`flex items-center justify-center text-xs text-muted ${chartHeightClass}`}
      >
        Not enough trades yet for a chart
      </div>
    );
  }

  const w = 800;
  const h = chartInnerH;
  const pad = { t: 20, r: 8, b: 24, l: 48 };
  const iw = w - pad.l - pad.r;
  const ih = h - pad.t - pad.b;
  const lows = candles.map((c) => c.low);
  const highs = candles.map((c) => c.high);
  const minP = Math.min(...lows);
  const maxP = Math.max(...highs);
  const range = maxP - minP || 1;
  const y = (p: number) => pad.t + ih - ((p - minP) / range) * ih;
  const step = iw / candles.length;
  const bw = Math.max(2, step * 0.65);
  const entryY =
    entryLine != null && Number.isFinite(entryLine)
      ? y(Math.max(minP - range * 0.02, Math.min(maxP + range * 0.02, entryLine)))
      : null;

  return (
    <div className="w-full overflow-x-auto">
      <svg
        viewBox={`0 0 ${w} ${h}`}
        className={`${chartHeightClass} w-full min-w-[320px]`}
      >
        {[0, 0.25, 0.5, 0.75, 1].map((f) => {
          const p = minP + range * f;
          const yy = y(p);
          return (
            <g key={f}>
              <line x1={pad.l} y1={yy} x2={w - pad.r} y2={yy} stroke="currentColor" strokeOpacity={0.08} />
              <text x={pad.l - 4} y={yy + 3} textAnchor="end" className="fill-muted text-[9px]">
                {p.toFixed(2)}
              </text>
            </g>
          );
        })}
        {candles.map((c, i) => {
          const cx = pad.l + i * step + step / 2;
          const up = c.close >= c.open;
          const color = up ? "#22c55e" : "#ef4444";
          const top = y(Math.max(c.open, c.close));
          const bot = y(Math.min(c.open, c.close));
          const bodyH = Math.max(1, bot - top);
          const wickTop = y(c.high);
          const wickBot = y(c.low);
          return (
            <g key={c.t}>
              <line x1={cx} y1={wickTop} x2={cx} y2={wickBot} stroke={color} strokeWidth={1} />
              <rect x={cx - bw / 2} y={top} width={bw} height={bodyH} fill={color} opacity={0.85} />
            </g>
          );
        })}
        {entryY != null && (
          <g>
            <line
              x1={pad.l}
              y1={entryY}
              x2={w - pad.r}
              y2={entryY}
              stroke="#fbbf24"
              strokeWidth={1.5}
              strokeDasharray="6 4"
              opacity={0.9}
            />
            <text x={w - pad.r - 2} y={entryY - 4} textAnchor="end" className="fill-warn text-[8px]">
              entry {entryLine!.toFixed(2)}
            </text>
          </g>
        )}
        {placedTrades.map((t) => {
          const cx = pad.l + t.idx * step + step / 2;
          const price = t.vSol ?? candles[t.idx]?.close ?? minP;
          const isBuy = t.side === "buy";
          const priceY = y(price);
          const pinY = isBuy ? priceY - 22 : priceY + 22;
          const stroke = isBuy ? "#22c55e" : "#ef4444";
          const mcap = fmtMcap(t.mcapUsd);
          const tip = [
            isBuy ? "Your buy" : "Your sell",
            mcap ? `entry ${mcap}` : null,
            t.sizeSol != null ? `${t.sizeSol.toFixed(3)} SOL` : null,
            t.vSol != null ? `pool ${t.vSol.toFixed(2)} SOL` : null,
          ]
            .filter(Boolean)
            .join(" · ");
          return (
            <g key={t.id}>
              {showTradeCrosshair && (
                <>
                  <line
                    x1={cx}
                    y1={pad.t}
                    x2={cx}
                    y2={h - pad.b}
                    stroke="currentColor"
                    strokeOpacity={0.35}
                    strokeWidth={1}
                    strokeDasharray="4 3"
                  />
                  <line
                    x1={pad.l}
                    y1={priceY}
                    x2={w - pad.r}
                    y2={priceY}
                    stroke={stroke}
                    strokeOpacity={0.45}
                    strokeWidth={1}
                    strokeDasharray="4 3"
                  />
                </>
              )}
              <circle cx={cx} cy={pinY} r={11} fill="var(--bg, #0f1419)" stroke={stroke} strokeWidth={2.5} opacity={0.98}>
                <title>{tip}</title>
              </circle>
              <circle cx={cx} cy={pinY} r={4} fill={stroke} opacity={0.95} />
              {(showTradeCrosshair || !compact) && isBuy && (
                <text
                  x={cx}
                  y={pinY - 16}
                  textAnchor="middle"
                  className="fill-ok text-[9px] font-semibold"
                >
                  BUY
                </text>
              )}
            </g>
          );
        })}
        {placedMarkers.map((s) => {
          const cx = pad.l + s.idx * step + step / 2;
          const price = s.vSol ?? candles[s.idx]?.close ?? minP;
          const cy = y(price) - 10;
          const fill = markerColor(s.action);
          return (
            <g key={s.id}>
              <polygon
                points={`${cx},${cy} ${cx - 5},${cy + 8} ${cx + 5},${cy + 8}`}
                fill={fill}
                opacity={0.95}
              >
                <title>{`${s.action} · conf ${s.confluenceScore.toFixed(2)} · ${s.reason}`}</title>
              </polygon>
              <text x={cx} y={cy + 6} textAnchor="middle" className="fill-bg text-[7px] font-bold">
                {markerLabel(s.action)}
              </text>
            </g>
          );
        })}
      </svg>
      {!compact && (
      <div className="mt-1 flex flex-wrap items-center justify-center gap-3 text-[10px] text-muted">
        <span>Pool SOL · {hours}h</span>
        {trades.length > 0 && (
          <>
            <span className="flex items-center gap-1">
              <span className="inline-block h-3 w-3 rounded-full border-2 border-ok bg-ok/20" /> Your buy
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block h-3 w-3 rounded-full border-2 border-bad bg-bad/20" /> Your sell
            </span>
            <span className="text-warn">— entry line</span>
          </>
        )}
        {!hideSignalLegend && (
          <>
            <span className="flex items-center gap-1">
              <span className="inline-block h-0 w-0 border-x-4 border-b-[6px] border-x-transparent border-b-ok" />{" "}
              Buy+
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block h-2 w-2 rounded-full bg-accent" /> Watch
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block h-2 w-2 rounded-full bg-bad" /> Avoid
            </span>
            {signals.length > 0 && <span>{signals.length} signals</span>}
          </>
        )}
      </div>
      )}
    </div>
  );
}
