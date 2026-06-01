"use client";

import { useCallback, useState } from "react";
import { ExternalDexEmbed } from "@/components/ExternalDexEmbed";
import { RadarScoresStrip } from "@/components/RadarScoresStrip";
import { useMintLivePrice } from "@/components/terminal/MintLivePrice";
import { shortAddr, fmtSol, pumpfunCoin } from "@/lib/ui/format";

export function TokenDexView({ mint, compact }: { mint: string; compact?: boolean }) {
  const sharedPrice = useMintLivePrice();
  const [meta, setMeta] = useState<{ symbol: string | null; name: string | null }>({
    symbol: null,
    name: null,
  });

  const onMeta = useCallback((symbol: string | null, name: string | null) => {
    setMeta({ symbol, name });
  }, []);

  const symbol =
    meta.symbol ?? sharedPrice?.symbol ?? shortAddr(mint, 4, 4);
  const displayVSol = sharedPrice?.vSol ?? null;

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
        <ExternalDexEmbed mint={mint} compact />
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
      <ExternalDexEmbed mint={mint} />
      <RadarScoresStrip mint={mint} onMeta={onMeta} />
    </section>
  );
}
