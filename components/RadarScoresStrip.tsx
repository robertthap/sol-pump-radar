"use client";

import { useCallback, useEffect, useState } from "react";
import { useVisibleInterval } from "@/lib/ui/useVisibleInterval";

type Snapshot = {
  symbol: string | null;
  name: string | null;
  gradScore: number | null;
  rugScore: number | null;
  confluenceScore: number | null;
  lastAction: string | null;
};

/** Lightweight SolPump scores — chart/trades come from embedded DEX. */
export function RadarScoresStrip({
  mint,
  compact,
  onMeta,
}: {
  mint: string;
  compact?: boolean;
  onMeta?: (symbol: string | null, name: string | null) => void;
}) {
  const [snap, setSnap] = useState<Snapshot | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch(`/api/tokens/${mint}/snapshot`, { cache: "no-store" });
      if (!r.ok) return;
      const j = (await r.json()) as Snapshot;
      setSnap(j);
      onMeta?.(j.symbol, j.name);
    } catch {
      /* ignore */
    }
  }, [mint, onMeta]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useVisibleInterval(refresh, 25_000, [refresh]);

  if (!snap) return null;

  return (
    <div
      className={`flex flex-wrap items-center gap-3 rounded-lg border border-border bg-panel/60 px-3 py-2 text-xs ${
        compact ? "mt-2" : "mt-1"
      }`}
    >
      <span className="text-[10px] font-semibold uppercase tracking-wide text-muted">
        Radar
      </span>
      <Score label="Pump" v={snap.gradScore} />
      <Score label="Risk" v={snap.rugScore} bad />
      <Score label="Signal" v={snap.confluenceScore} />
      {snap.lastAction && (
        <span className="pill text-[10px] text-accent">{snap.lastAction.replace(/_/g, " ")}</span>
      )}
    </div>
  );
}

function Score({ label, v, bad }: { label: string; v: number | null; bad?: boolean }) {
  const cls =
    v == null
      ? "text-muted"
      : bad && v >= 0.5
        ? "text-bad"
        : !bad && v >= 0.6
          ? "text-ok"
          : "text-fg";
  return (
    <span>
      <span className="text-muted">{label} </span>
      <span className={`font-mono ${cls}`}>{v?.toFixed(2) ?? "—"}</span>
    </span>
  );
}
