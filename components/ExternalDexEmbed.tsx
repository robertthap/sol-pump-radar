"use client";

import { useCallback, useEffect, useState } from "react";
import { pumpfunCoin, relTime } from "@/lib/ui/format";
import { TradingChart } from "@/components/chart/TradingChart";
import type { UserTrade } from "@/lib/chart/types";
import { useVisibleInterval } from "@/lib/ui/useVisibleInterval";

export type DexTradeMarker = {
  id: string;
  side: "buy" | "sell";
  ts: string;
  sizeSol?: number | null;
  mcapUsd?: number | null;
  vSol?: number | null;
};

export type DexTradeHud = {
  status: "open" | "closed";
  entryMcapUsd?: number | null;
  pnlPct?: number | null;
  pnlSol?: number | null;
};

function fmtMcap(v: number | null | undefined) {
  if (v == null || !Number.isFinite(v)) return null;
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}K`;
  return `$${Math.round(v)}`;
}

type Props = {
  mint: string;
  compact?: boolean;
  className?: string;
  tradeMarkers?: DexTradeMarker[];
  showTradeBadges?: boolean;
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
  const [userTrades, setUserTrades] = useState<UserTrade[] | undefined>();
  const [now, setNow] = useState(0);

  useEffect(() => {
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, []);

  const loadTrades = useCallback(() => {
    void fetch(`/api/tokens/${encodeURIComponent(mint)}/user-trades`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { trades: [] }))
      .then((j: { trades: UserTrade[] }) => setUserTrades(j.trades ?? []))
      .catch(() => setUserTrades([]));
  }, [mint]);

  useEffect(() => {
    loadTrades();
  }, [loadTrades]);

  useVisibleInterval(loadTrades, 15_000, [loadTrades]);

  const height = compact ? 360 : 480;

  return (
    <div className={`dex-embed ${className ?? ""}`}>
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
              </div>
            );
          })}
        </div>
      )}

      <TradingChart
        mint={mint}
        height={height}
        entryMcapUsd={hud?.entryMcapUsd}
        pnlPct={hud?.pnlPct}
        status={hud?.status}
        userTrades={userTrades}
        showSideHud={Boolean(hud)}
      />

      <p className="mt-1 text-[10px] text-muted">
        Native chart ·{" "}
        <a href={pumpfunCoin(mint)} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">
          pump.fun ↗
        </a>
      </p>
    </div>
  );
}
