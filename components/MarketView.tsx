"use client";

import { useCallback, useMemo, useState } from "react";
import { TrenchColumn } from "@/components/TrenchCoinCard";
import { PumpCoinSearch } from "@/components/PumpCoinSearch";
import { useVisibleInterval } from "@/lib/ui/useVisibleInterval";
import type { MarketCoin, MarketFeed, MarketFilter } from "@/lib/market/types";
import { matchesMarketFilter } from "@/lib/market/types";

const FILTERS: { id: MarketFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "strong_buy", label: "Strong buy" },
  { id: "tradable", label: "Tradable" },
  { id: "avoid", label: "Avoid / rug" },
];

function filterColumn(coins: MarketCoin[], filter: MarketFilter): MarketCoin[] {
  return coins.filter((c) => matchesMarketFilter(c, filter));
}

function mergeCoinAnalysis(prev: MarketCoin, next: MarketCoin): MarketCoin {
  const nextScanning =
    next.analysis.primaryFlag === "scanning" || next.analysis.primaryFlag === "warming_up";
  const prevScored =
    prev.analysis.primaryFlag !== "scanning" && prev.analysis.primaryFlag !== "warming_up";
  if (nextScanning && prevScored) {
    return { ...next, analysis: prev.analysis };
  }
  return next;
}

function mergeFeedColumn(prev: MarketCoin[] | undefined, next: MarketCoin[]): MarketCoin[] {
  if (!prev?.length) return next;
  const prevByMint = new Map(prev.map((c) => [c.mint, c]));
  return next.map((c) => {
    const old = prevByMint.get(c.mint);
    return old ? mergeCoinAnalysis(old, c) : c;
  });
}

function mergeFeed(prev: MarketFeed | null, next: MarketFeed): MarketFeed {
  if (!prev) return next;
  return {
    ...next,
    new: mergeFeedColumn(prev.new, next.new),
    trending: mergeFeedColumn(prev.trending, next.trending),
    migrated: mergeFeedColumn(prev.migrated, next.migrated),
  };
}

export function MarketView() {
  const [feed, setFeed] = useState<MarketFeed | null>(null);
  const [filter, setFilter] = useState<MarketFilter>("all");
  const [now, setNow] = useState(0);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/market/feed", { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const next = (await r.json()) as MarketFeed;
      setFeed((prev) => mergeFeed(prev, next));
      setErr(null);
    } catch (e) {
      setErr(String(e));
    }
  }, []);

  useVisibleInterval(load, 10_000, [load]);
  useVisibleInterval(() => setNow(Date.now()), 2_000, []);

  const columns = useMemo(
    () => [
      {
        title: "New",
        coins: filterColumn(feed?.new ?? [], filter),
        empty: feed ? "No coins match filter" : "Loading…",
      },
      {
        title: "Trending",
        coins: filterColumn(feed?.trending ?? [], filter),
        empty: feed ? "No coins match filter" : "Loading…",
      },
      {
        title: "Graduated",
        coins: filterColumn(feed?.migrated ?? [], filter),
        empty: feed ? "No coins match filter" : "Loading…",
      },
    ],
    [feed, filter],
  );

  const sourceHint = feed?.sources
    ? [
        feed.sources.gmgn ? "GMGN" : null,
        feed.sources.pump ? "pump.fun" : null,
        feed.sources.dexscreener ? "DexScreener" : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : "";

  return (
    <div className="market-view">
      <header className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Market</h1>
          <p className="text-[11px] text-muted">
            Coins from {sourceHint || "pump.fun"} — each flagged by SolPump Radar
          </p>
        </div>
        <PumpCoinSearch compact />
      </header>

      <div className="market-legend mb-3 flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            className={`market-filter-btn ${filter === f.id ? "market-filter-active" : ""}`}
            onClick={() => setFilter(f.id)}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="market-legend mb-3 flex flex-wrap gap-2 text-[10px] text-muted">
        <span className="market-flag-pill market-flag-strong">Strong buy</span>
        <span className="market-flag-pill market-flag-buy">Tradable</span>
        <span className="market-flag-pill market-flag-watch">Watch</span>
        <span className="market-flag-pill market-flag-caution">Caution</span>
        <span className="market-flag-pill market-flag-avoid">Avoid / rug</span>
        <span className="market-flag-pill market-flag-scan">Scanning</span>
      </div>

      {err && <p className="mb-2 text-xs text-bad">{err}</p>}

      <div className="trenches-grid">
        {columns.map((col) => (
          <TrenchColumn
            key={col.title}
            title={col.title}
            coins={col.coins}
            now={now}
            emptyLabel={col.empty}
            showAnalysis
          />
        ))}
      </div>
    </div>
  );
}
