"use client";

import { useCallback, useEffect, useState } from "react";
import {
  TokenChart,
  type TokenChartHud,
} from "@/components/chart/TokenChart";
import { RadarScoresStrip } from "@/components/RadarScoresStrip";
import { useMintLivePrice } from "@/components/terminal/MintLivePrice";
import { shortAddr, fmtSol, pumpfunCoin } from "@/lib/ui/format";

type AutoPositionRow = {
  id: string;
  mint: string;
  status: "open" | "closed";
  entryMcapUsd: number | null;
  currentMcapUsd: number | null;
  pctOfSize: number | null;
  markers: { id: string; ts: string; side: "buy" | "sell"; vSol: number | null }[];
};

export function TokenDexView({ mint, compact }: { mint: string; compact?: boolean }) {
  const sharedPrice = useMintLivePrice();
  const [meta, setMeta] = useState<{ symbol: string | null; name: string | null }>({
    symbol: null,
    name: null,
  });
  const [hud, setHud] = useState<TokenChartHud | undefined>();

  const onMeta = useCallback((symbol: string | null, name: string | null) => {
    setMeta({ symbol, name });
  }, []);

  useEffect(() => {
    let alive = true;
    void fetch("/api/auto/positions", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { open?: AutoPositionRow[]; closed?: AutoPositionRow[] } | null) => {
        if (!alive || !j) return;
        const p = [...(j.open ?? []), ...(j.closed ?? [])].find((x) => x.mint === mint);
        if (!p) {
          setHud(undefined);
          return;
        }
        setHud({
          status: p.status,
          entryMcapUsd: p.entryMcapUsd,
          currentMcapUsd: p.currentMcapUsd,
          pnlPct: p.pctOfSize,
        });
      })
      .catch(() => {
        if (alive) setHud(undefined);
      });
    return () => {
      alive = false;
    };
  }, [mint]);

  const symbol =
    meta.symbol ?? sharedPrice?.symbol ?? shortAddr(mint, 4, 4);
  const displayVSol = sharedPrice?.vSol ?? null;
  const embed = (
    <TokenChart mint={mint} symbol={symbol} compact={compact} hud={hud} />
  );

  if (compact) {
    return (
      <section className="dex-page dex-page-compact">
        <header className="dex-header-compact">
          <div className="min-w-0">
            <h2 className="text-base font-bold">{symbol}</h2>
            {meta.name && <p className="truncate text-xs text-muted">{meta.name}</p>}
          </div>
          <div className="flex items-center gap-3 text-xs">
            <span className="font-mono text-warn">{fmtSol(displayVSol, 2)} SOL</span>
            <a
              href={pumpfunCoin(mint)}
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-ghost text-[10px]"
            >
              pump.fun
            </a>
          </div>
        </header>
        {embed}
        <RadarScoresStrip mint={mint} compact onMeta={onMeta} />
      </section>
    );
  }

  return (
    <section className="dex-page">
      <header className="dex-header">
        <div className="min-w-0">
          <h1 className="text-xl font-bold">{symbol}</h1>
          {meta.name && <p className="text-sm text-muted">{meta.name}</p>}
          <p className="font-mono text-[10px] text-muted">{shortAddr(mint, 6, 6)}</p>
        </div>
        <div className="flex flex-wrap items-center gap-4 text-xs">
          <div>
            <p className="text-[10px] text-muted">Pool</p>
            <p className="font-mono text-lg font-semibold text-warn">{fmtSol(displayVSol, 2)} SOL</p>
          </div>
          <a
            href={pumpfunCoin(mint)}
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn-ghost text-xs"
          >
            pump.fun ↗
          </a>
        </div>
      </header>
      {embed}
      <RadarScoresStrip mint={mint} onMeta={onMeta} />
    </section>
  );
}
