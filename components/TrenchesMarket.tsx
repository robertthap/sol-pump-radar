"use client";
import { useCallback, useEffect, useState } from "react";
import { TrenchColumn, type TrenchCoin } from "@/components/TrenchCoinCard";
import { PumpCoinSearch } from "@/components/PumpCoinSearch";
import { useVisibleInterval } from "@/lib/ui/useVisibleInterval";

type Feed = {
  new: TrenchCoin[];
  almostBonded: TrenchCoin[];
  migrated: TrenchCoin[];
};

export function TrenchesMarket({
  compact,
  onSelectMint,
  activeMint,
  onFeedLoaded,
  controlledFeed,
}: {
  compact?: boolean;
  onSelectMint?: (mint: string, vSol?: number | null) => void;
  activeMint?: string | null;
  onFeedLoaded?: (feed: Feed) => void;
  /** When set (including null while loading), parent owns the feed — no internal fetch. */
  controlledFeed?: Feed | null;
}) {
  const isControlled = controlledFeed !== undefined;
  const [feed, setFeed] = useState<Feed | null>(controlledFeed ?? null);
  const [now, setNow] = useState(0);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (isControlled) setFeed(controlledFeed);
  }, [controlledFeed, isControlled]);

  const load = useCallback(async () => {
    if (isControlled) return;
    try {
      const r = await fetch("/api/pump/trenches", { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setFeed((await r.json()) as Feed);
      setErr(null);
    } catch (e) {
      setErr(String(e));
    }
  }, [isControlled]);

  useVisibleInterval(load, compact ? 6_000 : 8_000, [load, isControlled]);
  useVisibleInterval(() => setNow(Date.now()), 2_000, []);

  useEffect(() => {
    if (feed) onFeedLoaded?.(feed);
  }, [feed, onFeedLoaded]);

  const columns = compact
    ? [{ title: "Hot", coins: feed?.new ?? [], empty: feed ? "No new coins" : "Loading…" }]
    : [
        { title: "New", coins: feed?.new ?? [], empty: feed ? "No new coins" : "Loading…" },
        {
          title: "Almost bonded",
          coins: feed?.almostBonded ?? [],
          empty: feed ? "Nothing close yet" : "Loading…",
        },
        {
          title: "Migrated",
          coins: feed?.migrated ?? [],
          empty: feed ? "No migrated" : "Loading…",
        },
      ];

  return (
    <div className={`trenches-wrap ${compact ? "trenches-compact" : ""}`}>
      {!compact && (
        <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <h1 className="text-lg font-semibold tracking-tight">Trenches</h1>
          <div className="w-full min-w-0 sm:max-w-md">
            <PumpCoinSearch compact />
          </div>
        </div>
      )}
      {err && <p className="mb-2 text-xs text-bad">{err}</p>}
      <div className={`trenches-grid ${compact ? "trenches-grid-compact" : ""}`}>
        {columns.map((col) => (
          <TrenchColumn
            key={col.title}
            title={col.title}
            coins={col.coins}
            now={now}
            emptyLabel={col.empty}
            onSelectMint={onSelectMint}
            activeMint={activeMint}
            compact={compact}
          />
        ))}
      </div>
    </div>
  );
}
