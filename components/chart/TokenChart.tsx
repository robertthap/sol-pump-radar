"use client";

/**
 * Unified token chart shell — loads user trades, renders TradingChart.
 * Use everywhere a mint price chart is shown.
 */

import { useCallback, useEffect, useState } from "react";
import { TradingChart } from "@/components/chart/TradingChart";
import type { UserTrade } from "@/lib/chart/types";
import { useVisibleInterval } from "@/lib/ui/useVisibleInterval";

export type TokenChartHud = {
  status: "open" | "closed";
  entryMcapUsd?: number | null;
  currentMcapUsd?: number | null;
  pnlPct?: number | null;
};

type Props = {
  mint: string;
  symbol?: string | null;
  name?: string | null;
  compact?: boolean;
  className?: string;
  hud?: TokenChartHud;
  scrollToBuy?: boolean;
};

export function TokenChart({ mint, symbol, compact, className, hud, scrollToBuy }: Props) {
  const [userTrades, setUserTrades] = useState<UserTrade[]>([]);

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

  const height = compact ? 400 : 520;

  return (
    <div className={className}>
      <TradingChart
        mint={mint}
        symbol={symbol}
        height={height}
        entryMcapUsd={hud?.entryMcapUsd}
        currentMcapUsd={hud?.currentMcapUsd}
        pnlPct={hud?.pnlPct}
        status={hud?.status}
        userTrades={userTrades}
        showSideHud={Boolean(hud)}
        scrollToBuy={scrollToBuy}
      />
    </div>
  );
}

/** @deprecated Use TokenChart */
export const ExternalDexEmbed = TokenChart;

export type DexTradeHud = TokenChartHud;
