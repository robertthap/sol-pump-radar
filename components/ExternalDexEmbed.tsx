"use client";

import { useCallback, useEffect, useState } from "react";
import { pumpfunCoin, relTime, shortAddr } from "@/lib/ui/format";
import type { DexEmbedConfig } from "@/lib/dex/embed";

export type DexTradeMarker = {
  id: string;
  side: "buy" | "sell";
  ts: string;
  sizeSol?: number | null;
  mcapUsd?: number | null;
  vSol?: number | null;
};

/** Live trade HUD rendered as an overlay on top of the DexScreener chart. */
export type DexTradeHud = {
  status: "open" | "closed";
  entryMcapUsd?: number | null;
  /** Fractional PnL of position size, e.g. 0.05 = +5%. */
  pnlPct?: number | null;
  pnlSol?: number | null;
};

function fmtMcap(v: number | null | undefined) {
  if (v == null || !Number.isFinite(v)) return null;
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}K`;
  return `$${Math.round(v)}`;
}

function fmtPct(v: number | null | undefined) {
  if (v == null || !Number.isFinite(v)) return null;
  const p = v * 100;
  return `${p >= 0 ? "+" : ""}${p.toFixed(1)}%`;
}

type Props = {
  mint: string;
  compact?: boolean;
  className?: string;
  /** Buy/sell marker chips shown above the embed. */
  tradeMarkers?: DexTradeMarker[];
  showTradeBadges?: boolean;
  /** Live entry + PnL overlay drawn on top of the chart (re-renders as parent polls). */
  hud?: DexTradeHud;
};

export function ExternalDexEmbed({
  mint,
  compact,
  className,
  tradeMarkers,
  showTradeBadges = true,
  hud,
}: Props) {
  const [config, setConfig] = useState<DexEmbedConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [iframeKey, setIframeKey] = useState(0);
  const [now, setNow] = useState(0);

  useEffect(() => {
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const r = await fetch(`/api/dex/embed?mint=${encodeURIComponent(mint)}`, {
        cache: "no-store",
      });
      if (!r.ok) {
        if (r.status === 404) {
          setErr("Not on DexScreener yet — very new coins show up after first trades.");
          setConfig(null);
          return;
        }
        throw new Error(`HTTP ${r.status}`);
      }
      setConfig((await r.json()) as DexEmbedConfig);
    } catch (e) {
      setErr(String(e));
      setConfig(null);
    } finally {
      setLoading(false);
    }
  }, [mint]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    setConfig(null);
    setIframeKey((k) => k + 1);
  }, [mint]);

  const height = compact ? "min(520px, 58vh)" : "min(720px, 72vh)";
  const dexSearchUrl = `https://dexscreener.com/search?q=${encodeURIComponent(mint)}`;

  return (
    <div className={`dex-embed ${className ?? ""}`}>
      <div className="dex-embed-toolbar">
        <span className="text-xs font-medium text-muted">
          {config?.symbol ?? shortAddr(mint, 4, 4)}
          {config?.dexId ? (
            <span className="ml-2 font-normal text-[10px] uppercase">{config.dexId}</span>
          ) : null}
        </span>
        <div className="flex flex-wrap items-center gap-1">
          <a
            href={config?.externalUrl ?? dexSearchUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn-ghost text-[10px]"
          >
            DexScreener ↗
          </a>
          <a
            href={pumpfunCoin(mint)}
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn-ghost text-[10px]"
          >
            pump.fun ↗
          </a>
          <button
            type="button"
            className="btn btn-ghost text-[10px]"
            onClick={() => {
              setIframeKey((k) => k + 1);
              void load();
            }}
          >
            Refresh
          </button>
        </div>
      </div>

      {showTradeBadges && tradeMarkers && tradeMarkers.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {tradeMarkers.map((m) => {
            const mcap = fmtMcap(m.mcapUsd);
            return (
              <div
                key={m.id}
                className={`flex items-center gap-2 rounded-md border px-2 py-1 text-[10px] ${
                  m.side === "buy"
                    ? "border-ok/40 bg-ok/10 text-ok"
                    : "border-bad/40 bg-bad/10 text-bad"
                }`}
              >
                <span className="font-semibold uppercase">{m.side === "buy" ? "Your buy" : "Your sell"}</span>
                {now > 0 && <span className="text-muted">{relTime(m.ts, now)}</span>}
                {mcap && <span>entry {mcap}</span>}
                {m.sizeSol != null && Number.isFinite(m.sizeSol) && (
                  <span className="font-mono">{m.sizeSol.toFixed(3)} SOL</span>
                )}
                {m.vSol != null && Number.isFinite(m.vSol) && (
                  <span className="text-muted">pool {m.vSol.toFixed(2)} SOL</span>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div
        className="dex-embed-frame card relative overflow-hidden"
        style={{ height, minHeight: compact ? 360 : 480 }}
      >
        {loading && (
          <div className="flex h-full items-center justify-center text-sm text-muted">
            Loading DexScreener…
          </div>
        )}
        {!loading && err && (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-sm">
            <p className="text-muted">{err}</p>
            <div className="flex flex-wrap justify-center gap-2">
              <a href={pumpfunCoin(mint)} target="_blank" rel="noopener noreferrer" className="btn btn-ghost">
                pump.fun ↗
              </a>
              <a href={dexSearchUrl} target="_blank" rel="noopener noreferrer" className="btn btn-ghost">
                Search DexScreener ↗
              </a>
            </div>
          </div>
        )}
        {!loading && config?.embedUrl && (
          <iframe
            key={iframeKey}
            src={config.embedUrl}
            title="DexScreener chart"
            className="h-full w-full border-0 bg-bg"
            loading="lazy"
            allow="clipboard-write"
            sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
          />
        )}

        {/* Live trade HUD — our own overlay on top of the 3rd-party chart (we can't
            draw inside the iframe, so the entry + live PnL ride here as a HUD). */}
        {!loading && config?.embedUrl && hud && (
          <div className="pointer-events-none absolute left-2 top-2 z-10 flex flex-col gap-1">
            <div
              className={`flex items-center gap-2 rounded-md border px-2 py-1 text-[11px] font-medium shadow-sm backdrop-blur ${
                hud.status === "open"
                  ? "border-ok/50 bg-bg/85 text-ok"
                  : "border-border/60 bg-bg/85 text-muted"
              }`}
            >
              <span className="inline-block h-2 w-2 rounded-full bg-ok" aria-hidden />
              <span className="uppercase tracking-wide">
                {hud.status === "open" ? "Your entry" : "Closed"}
              </span>
              {fmtMcap(hud.entryMcapUsd) && (
                <span className="text-fg">@ {fmtMcap(hud.entryMcapUsd)}</span>
              )}
              {fmtPct(hud.pnlPct) && (
                <span
                  className={`font-mono ${
                    (hud.pnlPct ?? 0) >= 0 ? "text-ok" : "text-bad"
                  }`}
                >
                  {fmtPct(hud.pnlPct)}
                </span>
              )}
            </div>
          </div>
        )}
      </div>
      <p className="text-[10px] text-muted">
        Live DexScreener chart · your entries are marked above and on the chart overlay.
      </p>
    </div>
  );
}
